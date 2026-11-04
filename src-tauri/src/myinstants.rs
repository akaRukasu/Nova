use reqwest::{blocking::Client, redirect::Policy, Url};
use serde::{Deserialize, Serialize};
use std::{collections::VecDeque, io::Read, sync::{Arc, Mutex}, time::{Duration, Instant}};

const MAX_AUDIO: usize = 8 * 1024 * 1024;
#[derive(Debug)]
pub struct Failure { pub status: u16, pub message: String }
fn fail(status: u16, message: impl Into<String>) -> Failure { Failure { status, message: message.into() } }
pub type Fetch = Arc<dyn Fn(&str, usize) -> Result<Vec<u8>, Failure> + Send + Sync>;

#[derive(Clone, Deserialize, Serialize)]
pub struct Sound { pub name: String, pub slug: String, pub sound: String, #[serde(default)] pub color: String }
#[derive(Clone, Serialize)]
pub struct Page { pub count: u64, pub next: bool, pub results: Vec<Sound> }
#[derive(Deserialize)]
struct ApiPage { count: u64, next: Option<String>, results: Vec<Sound> }
struct State {
    requests: VecDeque<Instant>,
    pages: VecDeque<(String, u32, Instant, Page)>,
    audio: VecDeque<(String, Arc<Vec<u8>>)>,
}
pub struct Catalog { state: Mutex<State>, fetch: Fetch }

fn slug_ok(slug: &str) -> bool { !slug.is_empty() && slug.len() <= 160 && slug.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') }
fn sound_url_ok(value: &str) -> bool {
    Url::parse(value).is_ok_and(|url| url.scheme() == "https" && matches!(url.host_str(), Some("www.myinstants.com" | "myinstants.com"))
        && url.port().is_none() && url.username().is_empty() && url.password().is_none()
        && url.path().starts_with("/media/sounds/") && url.path().ends_with(".mp3"))
}
fn http_get(url: &str, limit: usize) -> Result<Vec<u8>, Failure> {
    let client = Client::builder().timeout(Duration::from_secs(15)).redirect(Policy::none())
        .user_agent("NovaCord Myinstants integration").build().map_err(|_| fail(502,"Connexion Myinstants indisponible."))?;
    let response = client.get(url).header("Accept", "application/json, audio/*").send().map_err(|_| fail(502,"Myinstants est injoignable. Vérifie la connexion Internet du PC."))?;
    if response.status().as_u16() == 429 { return Err(fail(429,"Limite Myinstants atteinte. Patiente une minute avant une nouvelle recherche.")); }
    if !response.status().is_success() { return Err(fail(502,"Myinstants n’a pas pu fournir ce contenu.")); }
    if response.content_length().is_some_and(|length| length > limit as u64) { return Err(fail(413,"Ce son dépasse la limite de 8 Mo.")); }
    let mut bytes = Vec::new();
    response.take((limit+1) as u64).read_to_end(&mut bytes).map_err(|_| fail(502,"Téléchargement Myinstants interrompu."))?;
    if bytes.len() > limit { return Err(fail(413,"Contenu Myinstants trop volumineux.")); }
    Ok(bytes)
}
impl Catalog {
    pub fn new() -> Self { Self::with_fetch(Arc::new(http_get)) }
    pub fn with_fetch(fetch: Fetch) -> Self { Self { state: Mutex::new(State { requests: VecDeque::new(), pages: VecDeque::new(), audio: VecDeque::new() }), fetch } }
    pub fn search(&self, query: &str, page: u32) -> Result<Page, Failure> {
        let query = query.trim();
        if query.chars().count() < 2 || query.chars().count() > 100 || !(1..=50).contains(&page) { return Err(fail(400,"Recherche entre 2 et 100 caractères, page entre 1 et 50.")); }
        // ponytail: one shared network operation at a time; a worker queue only if multi-user throughput becomes necessary.
        let mut state = self.state.lock().unwrap();
        state.pages.retain(|(_,_,time,_)| time.elapsed() < Duration::from_secs(600));
        if let Some((_,_,_,cached)) = state.pages.iter().find(|(name,number,_,_)| name == query && *number == page) { return Ok(cached.clone()); }
        while state.requests.front().is_some_and(|time| time.elapsed() >= Duration::from_secs(60)) { state.requests.pop_front(); }
        if state.requests.len() >= 10 { return Err(fail(429,format!("Limite Myinstants : réessaie dans {} s.",61-state.requests.front().unwrap().elapsed().as_secs()))); }
        state.requests.push_back(Instant::now());
        let mut url = Url::parse("https://www.myinstants.com/api/v1/instants/").unwrap();
        url.query_pairs_mut().append_pair("name",query).append_pair("page",&page.to_string());
        let bytes = (self.fetch)(url.as_str(), 1024*1024)?;
        let raw: ApiPage = serde_json::from_slice(&bytes).map_err(|_| fail(502,"Réponse Myinstants illisible."))?;
        let results = raw.results.into_iter().take(20).filter(|sound| slug_ok(&sound.slug) && sound_url_ok(&sound.sound)).map(|mut sound| {
            sound.name = sound.name.chars().take(160).collect();
            sound.color = if sound.color.len()==6 && sound.color.bytes().all(|c| c.is_ascii_hexdigit()) { format!("#{}",sound.color) } else { "#7c6bff".into() }; sound
        }).collect();
        let result = Page { count: raw.count, next: raw.next.is_some(), results };
        if state.pages.len() >= 20 { state.pages.pop_front(); }
        state.pages.push_back((query.into(),page,Instant::now(),result.clone())); Ok(result)
    }
    pub fn audio(&self, slug: &str) -> Result<(Sound, Arc<Vec<u8>>), Failure> {
        if !slug_ok(slug) { return Err(fail(400,"Identifiant Myinstants invalide.")); }
        let mut state = self.state.lock().unwrap();
        let sound = state.pages.iter().flat_map(|(_,_,_,page)| &page.results).find(|sound| sound.slug == slug).cloned().ok_or_else(|| fail(404,"Relance la recherche Myinstants pour retrouver ce son."))?;
        if let Some(index) = state.audio.iter().position(|(id,_)| id==slug) {
            let entry = state.audio.remove(index).unwrap(); let bytes = entry.1.clone(); state.audio.push_back(entry); return Ok((sound,bytes));
        }
        let bytes = (self.fetch)(&sound.sound, MAX_AUDIO)?;
        if bytes.is_empty() || bytes.len() > MAX_AUDIO { return Err(fail(413,"Son vide ou supérieur à 8 Mo.")); }
        let bytes = Arc::new(bytes);
        if state.audio.len() >= 6 { state.audio.pop_front(); }
        state.audio.push_back((slug.into(),bytes.clone())); Ok((sound,bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize,Ordering};
    #[test]
    fn official_search_contract_cache_limits_and_audio_allowlist() {
        let calls = Arc::new(AtomicUsize::new(0)); let counted = calls.clone();
        let catalog = Catalog::with_fetch(Arc::new(move |url,_| {
            counted.fetch_add(1,Ordering::Relaxed);
            if url.contains("/api/v1/") { Ok(br#"{"count":2,"next":null,"results":[{"name":"Test","slug":"test-12","sound":"https://www.myinstants.com/media/sounds/test.mp3","color":"AB1234"},{"name":"Bad","slug":"bad","sound":"http://127.0.0.1/private.mp3","color":"000000"}]}"#.to_vec()) }
            else { Ok(b"audio".to_vec()) }
        }));
        let page = catalog.search("test",1).unwrap(); assert_eq!(page.results.len(),1); assert_eq!(page.results[0].color,"#AB1234");
        catalog.search("test",1).unwrap(); assert_eq!(calls.load(Ordering::Relaxed),1);
        assert_eq!(catalog.audio("test-12").unwrap().1.as_slice(), b"audio"); catalog.audio("test-12").unwrap();
        assert_eq!(calls.load(Ordering::Relaxed),2);
        assert!(catalog.audio("unknown").is_err()); assert!(catalog.search("x",1).is_err());
        for i in 0..9 { catalog.search(&format!("search-{i}"),1).unwrap(); }
        assert_eq!(catalog.search("limited",1).err().unwrap().status,429);
        assert!(!sound_url_ok("https://www.myinstants.com.evil.org/media/sounds/test.mp3"));
        assert!(!sound_url_ok("https://user@www.myinstants.com/media/sounds/test.mp3"));
    }
}
