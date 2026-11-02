use qrcode::{render::svg, QrCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, io::Read, net::{IpAddr, Ipv4Addr, SocketAddr}, sync::{atomic::{AtomicBool, Ordering}, mpsc, Arc, Mutex}, thread, time::{Duration, Instant}};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};
use uuid::Uuid;

const PAGE: &str = include_str!("../soundboard/index.html");
const MAX_UPLOAD: usize = 8 * 1024 * 1024;
pub type Dispatch = Arc<dyn Fn(Value) -> Result<(), String> + Send + Sync>;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct Sound {
    pub id: String,
    pub name: String,
    pub local: bool,
    #[serde(default)] pub favorite: bool,
    #[serde(default)] pub category: String,
    #[serde(default)] pub color: String,
    #[serde(default)] pub shortcut: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Board {
    pub sounds: Vec<Sound>,
    pub enabled: bool,
    pub active: bool,
    pub volume: f64,
    #[serde(default = "default_monitor")] pub monitor: bool,
    #[serde(default = "default_monitor_volume")] pub monitor_volume: f64,
    #[serde(default)] pub error: String,
    #[serde(default)] pub last_playback: String,
}

impl Default for Board {
    fn default() -> Self { Self { sounds: vec![], enabled: false, active: false, volume: 0.7, monitor: true, monitor_volume: 0.7, error: String::new(), last_playback: String::new() } }
}
fn default_monitor() -> bool { true }
fn default_monitor_volume() -> f64 { 0.7 }

struct Data {
    board: Board,
    synced: Option<Instant>,
    revision: u64,
    port: u16,
    addresses: Vec<(String, Ipv4Addr)>,
    desktop_key: String,
    phone_key: String,
    lan: bool,
    phone_seen: Option<Instant>,
}

pub struct Service {
    data: Mutex<Data>,
    pending: Mutex<HashMap<String, mpsc::SyncSender<Result<(), String>>>>,
    uploads: Mutex<HashMap<String, Vec<u8>>>,
    stopped: AtomicBool,
}

fn key() -> String { Uuid::new_v4().simple().to_string() }
fn addresses() -> Vec<(String, Ipv4Addr)> {
    let preferred = local_ip_address::local_ip().ok();
    let mut interfaces: Vec<_> = local_ip_address::list_afinet_netifas().unwrap_or_default().into_iter().filter_map(|(name, ip)| match ip {
        IpAddr::V4(ip) if !ip.is_loopback() && (ip.is_private() || ip.is_link_local()) => Some((name, ip)), _ => None,
    }).collect();
    interfaces.sort_by_key(|(name, ip)| {
        let name = name.to_lowercase();
        let wifi = ["wi-fi", "wifi", "wlan", "wireless"].iter().any(|part| name.contains(part));
        (!wifi, Some(IpAddr::V4(*ip)) != preferred, name.contains("vpn") || name.contains("virtual"), *ip)
    });
    interfaces.dedup_by_key(|(_, ip)| *ip);
    interfaces
}
fn local(ip: IpAddr) -> bool { match ip { IpAddr::V4(ip) => ip.is_private() || ip.is_loopback() || ip.is_link_local(), IpAddr::V6(ip) => ip.is_loopback() } }
fn header<'a>(request: &'a Request, name: &str) -> Option<&'a str> {
    request.headers().iter().find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name)).map(|h| h.value.as_str())
}

fn respond(request: Request, status: u16, body: String, mime: &str, etag: Option<String>) {
    let mut response = Response::from_string(body).with_status_code(StatusCode(status));
    for (name, value) in [
        ("Content-Type", mime), ("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff"),
        ("Referrer-Policy", "no-referrer"), ("X-Frame-Options", "DENY"),
        ("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"),
    ] {
        response.add_header(Header::from_bytes(name, value).unwrap());
    }
    if let Some(etag) = etag { response.add_header(Header::from_bytes("ETag", etag).unwrap()); }
    let _ = request.respond(response);
}

fn json_response(request: Request, status: u16, value: Value) { respond(request, status, value.to_string(), "application/json; charset=utf-8", None); }

impl Service {
    pub fn new() -> Self {
        Self { data: Mutex::new(Data { board: Board::default(), synced: None, revision: 0, port: 0, addresses: vec![], desktop_key: key(), phone_key: key(), lan: false, phone_seen: None }),
            pending: Mutex::new(HashMap::new()), uploads: Mutex::new(HashMap::new()), stopped: AtomicBool::new(false) }
    }

    pub fn sync(&self, mut board: Board) -> Result<(), String> {
        if board.sounds.len() > 5000 || !board.volume.is_finite() || !(0.0..=1.0).contains(&board.volume)
            || !board.monitor_volume.is_finite() || !(0.0..=1.0).contains(&board.monitor_volume) { return Err("Bibliothèque invalide.".into()); }
        for sound in &mut board.sounds {
            if sound.id.is_empty() || sound.id.len() > 128 { return Err("Identifiant de son invalide.".into()); }
            sound.name = sound.name.chars().take(160).collect();
            sound.category = sound.category.chars().take(48).collect();
            sound.shortcut = sound.shortcut.chars().take(80).collect();
            if sound.color.len() != 7 || !sound.color.starts_with('#') || !sound.color[1..].bytes().all(|b| b.is_ascii_hexdigit()) { sound.color = "#7c6bff".into(); }
        }
        board.error = board.error.chars().take(400).collect();
        board.last_playback = board.last_playback.chars().take(400).collect();
        let mut data = self.data.lock().unwrap();
        if board != data.board { data.revision += 1; data.board = board; }
        data.synced = Some(Instant::now());
        Ok(())
    }

    pub fn complete(&self, request_id: &str, error: Option<String>) {
        if let Some(sender) = self.pending.lock().unwrap().remove(request_id) {
            let _ = sender.send(error.map_or(Ok(()), Err));
        }
    }

    pub fn take_upload(&self, id: &str) -> Result<Vec<u8>, String> {
        self.uploads.lock().unwrap().remove(id).ok_or_else(|| "Import expiré ou introuvable.".into())
    }

    pub fn shutdown(&self) { self.stopped.store(true, Ordering::Relaxed); }
    pub fn port(&self) -> u16 { self.data.lock().unwrap().port }
    pub fn has_sound(&self, name: &str) -> bool { self.data.lock().unwrap().board.sounds.iter().any(|sound| sound.name == name) }

    pub fn desktop_url(&self) -> String {
        let data = self.data.lock().unwrap();
        format!("http://127.0.0.1:{}/#key={}", data.port, data.desktop_key)
    }

    pub fn start(self: &Arc<Self>, dispatch: Dispatch) -> Result<String, String> {
        let mut data = self.data.lock().unwrap();
        if data.port != 0 { drop(data); return Ok(self.desktop_url()); }
        let server = Arc::new(Server::http(("0.0.0.0", 38427)).or_else(|_| Server::http(("0.0.0.0", 0))).map_err(|e| e.to_string())?);
        data.port = server.server_addr().to_ip().ok_or("Adresse réseau indisponible.")?.port();
        data.addresses = addresses();
        drop(data);
        for _ in 0..3 {
            let service = self.clone(); let server = server.clone(); let dispatch = dispatch.clone();
            thread::spawn(move || while !service.stopped.load(Ordering::Relaxed) {
                match server.recv_timeout(Duration::from_millis(200)) {
                    Ok(Some(request)) => service.handle(request, &dispatch),
                    Ok(None) => {}, Err(_) => break,
                }
            });
        }
        Ok(self.desktop_url())
    }

    fn command(&self, mut action: Value, dispatch: &Dispatch) -> Result<(), String> {
        {
            let data = self.data.lock().unwrap();
            if data.synced.is_none_or(|time| time.elapsed() > Duration::from_secs(6)) { return Err("NovaCord n'est pas prêt. Ouvre Discord sur le PC.".into()); }
            let kind = action["action"].as_str().ok_or("Action manquante.")?;
            if !matches!(kind, "play" | "preview" | "stop" | "volume" | "monitor" | "monitor-volume" | "enable" | "refresh" | "edit" | "delete" | "import") { return Err("Action inconnue.".into()); }
            if matches!(kind, "play" | "preview" | "edit" | "delete") {
                let sound = data.board.sounds.iter().find(|s| Some(s.id.as_str()) == action["id"].as_str()).ok_or("Son introuvable.")?;
                if kind == "delete" && !sound.local { return Err("Seuls les sons importés peuvent être supprimés.".into()); }
            }
            if matches!(kind, "volume" | "monitor-volume") && !action["volume"].as_f64().is_some_and(|v| v.is_finite() && (0.0..=1.0).contains(&v)) { return Err("Volume invalide.".into()); }
            if matches!(kind, "enable" | "monitor") && !action["enabled"].is_boolean() { return Err("État invalide.".into()); }
            if kind == "edit" {
                for (field, max) in [("name", 160), ("category", 48)] {
                    if action[field].as_str().is_some_and(|value| value.chars().count() > max) { return Err("Libellé trop long.".into()); }
                }
            }
        }
        let request_id = key();
        action["requestId"] = json!(request_id);
        let (tx, rx) = mpsc::sync_channel(1);
        {
            let mut pending = self.pending.lock().unwrap();
            if pending.len() >= 8 { return Err("Trop de commandes en attente.".into()); }
            pending.insert(request_id.clone(), tx);
        }
        if let Err(error) = dispatch(action) { self.pending.lock().unwrap().remove(&request_id); return Err(error); }
        let result = rx.recv_timeout(Duration::from_secs(8)).unwrap_or_else(|_| Err("NovaCord ne répond pas. Vérifie que l'application est ouverte.".into()));
        self.pending.lock().unwrap().remove(&request_id);
        result
    }

    fn handle(&self, mut request: Request, dispatch: &Dispatch) {
        let peer = match request.remote_addr().copied() { Some(peer) if local(peer.ip()) => peer, _ => { json_response(request, 403, json!({"error":"Réseau local uniquement."})); return; } };
        let data = self.data.lock().unwrap();
        let port = data.port;
        let host = header(&request, "Host").unwrap_or("");
        let valid_host = host.parse::<SocketAddr>().is_ok_and(|addr| addr.port() == port && local(addr.ip()));
        let origin_ok = header(&request, "Origin").is_none_or(|origin| origin == format!("http://{host}"));
        if !valid_host || !origin_ok { drop(data); json_response(request, 403, json!({"error":"Origine non autorisée."})); return; }
        if request.method() == &Method::Get && request.url() == "/" { drop(data); respond(request, 200, PAGE.into(), "text/html; charset=utf-8", None); return; }
        let bearer = header(&request, "Authorization").unwrap_or("").strip_prefix("Bearer ").unwrap_or("");
        let desktop = peer.ip().is_loopback() && bearer == data.desktop_key;
        let phone = data.lan && bearer == data.phone_key;
        if !desktop && !phone { drop(data); json_response(request, 401, json!({"error":"Appairage nécessaire ou expiré."})); return; }
        drop(data);
        if phone { self.data.lock().unwrap().phone_seen = Some(Instant::now()); }

        if request.method() == &Method::Get && request.url() == "/api/state" {
            let data = self.data.lock().unwrap();
            let ready = data.synced.is_some_and(|time| time.elapsed() <= Duration::from_secs(6));
            let connected = data.lan && data.phone_seen.is_some_and(|time| time.elapsed() <= Duration::from_secs(5));
            let etag = format!("\"{}-{desktop}-{ready}-{connected}\"", data.revision);
            if header(&request, "If-None-Match") == Some(etag.as_str()) { drop(data); respond(request, 304, String::new(), "application/json", Some(etag)); return; }
            let mut value = json!({"board":data.board, "ready":ready, "desktop":desktop});
            if desktop {
                let links: Vec<Value> = data.addresses.iter().map(|(name, ip)| {
                    let url = format!("http://{ip}:{}/#key={}", data.port, data.phone_key);
                    let qr = if data.lan { QrCode::new(url.as_bytes()).ok().map(|code| code.render::<svg::Color>().min_dimensions(224,224).build()).unwrap_or_default() } else { String::new() };
                    json!({"address":ip.to_string(), "interface":name, "url":url, "qr":qr})
                }).collect();
                value["remote"] = json!({"enabled":data.lan, "connected":connected, "links":links});
            }
            drop(data); respond(request, 200, value.to_string(), "application/json; charset=utf-8", Some(etag)); return;
        }

        if request.method() == &Method::Post && request.url() == "/api/network-access" && desktop {
            let result = dispatch(json!({"action":"network-access", "requestId":""}));
            json_response(request, if result.is_ok() { 200 } else { 409 }, result.map_or_else(|error| json!({"error":error}), |_| json!({"ok":true}))); return;
        }
        if request.method() == &Method::Post && request.url() == "/api/remote" && desktop {
            let mut bytes = Vec::new();
            if request.as_reader().take(1025).read_to_end(&mut bytes).is_err() || bytes.len() > 1024 { json_response(request, 400, json!({"error":"Requête invalide."})); return; }
            let enabled = serde_json::from_slice::<Value>(&bytes).ok().and_then(|v| v["enabled"].as_bool());
            if let Some(enabled) = enabled {
                let interfaces = addresses();
                let mut data = self.data.lock().unwrap(); data.addresses = interfaces; data.lan = enabled; data.phone_key = key(); data.phone_seen = None; data.revision += 1;
                drop(data); json_response(request, 200, json!({"ok":true}));
            } else { json_response(request, 400, json!({"error":"État manquant."})); }
            return;
        }

        if request.method() == &Method::Post && request.url() == "/api/upload" && desktop {
            if request.body_length().is_some_and(|len| len > MAX_UPLOAD) { json_response(request, 413, json!({"error":"8 Mo maximum par son."})); return; }
            let name = header(&request, "X-Sound-Name").unwrap_or("son.wav").chars().take(512).collect::<String>();
            let mut bytes = Vec::new();
            if request.as_reader().take((MAX_UPLOAD + 1) as u64).read_to_end(&mut bytes).is_err() || bytes.len() > MAX_UPLOAD { json_response(request, 413, json!({"error":"Fichier trop volumineux ou invalide."})); return; }
            let upload_id = key();
            { let mut uploads = self.uploads.lock().unwrap(); if uploads.len() >= 2 { drop(uploads); json_response(request, 429, json!({"error":"Un import est déjà en cours."})); return; } uploads.insert(upload_id.clone(), bytes); }
            let result = self.command(json!({"action":"import", "upload_id":upload_id, "name":name}), dispatch);
            self.uploads.lock().unwrap().remove(&upload_id);
            json_response(request, if result.is_ok() {200} else {409}, result.map_or_else(|error| json!({"error":error}), |_| json!({"ok":true}))); return;
        }

        if request.method() == &Method::Post && request.url() == "/api/command" {
            let mut bytes = Vec::new();
            if request.as_reader().take(8193).read_to_end(&mut bytes).is_err() || bytes.len() > 8192 { json_response(request, 400, json!({"error":"Commande trop longue."})); return; }
            let action = match serde_json::from_slice::<Value>(&bytes) { Ok(value) if value.is_object() => value, _ => { json_response(request, 400, json!({"error":"Commande invalide."})); return; } };
            if action["action"] == "import" || (!desktop && matches!(action["action"].as_str(), Some("preview" | "monitor" | "monitor-volume"))) { json_response(request, 403, json!({"error":"Action réservée au PC."})); return; }
            let result = self.command(action, dispatch);
            json_response(request, if result.is_ok() {200} else {409}, result.map_or_else(|error| json!({"error":error}), |_| json!({"ok":true}))); return;
        }
        json_response(request, 403, json!({"error":"Action non autorisée."}));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;

    fn request(service: &Service, method: &str, path: &str, token: &str, body: &[u8], origin: Option<&str>) -> (u16, String) {
        let port = service.data.lock().unwrap().port;
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let origin = origin.map(|value| format!("Origin: {value}\r\n")).unwrap_or_default();
        write!(stream, "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\nConnection: close\r\n{origin}\r\n", body.len()).unwrap();
        stream.write_all(body).unwrap();
        let mut result = String::new(); stream.read_to_string(&mut result).unwrap();
        let status = result.lines().next().unwrap().split_whitespace().nth(1).unwrap().parse().unwrap();
        (status, result.split_once("\r\n\r\n").unwrap().1.to_owned())
    }

    #[test]
    fn pairing_origin_validation_commands_and_revocation_use_real_http() {
        let service = Arc::new(Service::new());
        let ready = Board { sounds: vec![Sound { id: "test-sound".into(), name: "Test".into(), local: true, ..Sound::default() }], active: true, enabled: true, ..Board::default() };
        service.sync(ready).unwrap();
        let callback = service.clone();
        let calls = Arc::new(Mutex::new(Vec::new())); let captured = calls.clone();
        service.start(Arc::new(move |action| {
            captured.lock().unwrap().push(action.clone());
            if action["action"] == "import" { assert_eq!(callback.take_upload(action["upload_id"].as_str().unwrap()).unwrap(), b"RIFFtest"); }
            callback.complete(action["requestId"].as_str().unwrap(), None); Ok(())
        })).unwrap();
        let desktop = service.data.lock().unwrap().desktop_key.clone();
        assert_eq!(request(&service, "GET", "/", "", b"", None).0, 200);
        assert_eq!(request(&service, "GET", "/api/state", "", b"", None).0, 401);
        assert_eq!(request(&service, "GET", "/api/state", &desktop, b"", None).0, 200);
        assert_eq!(request(&service, "POST", "/api/remote", &desktop, br#"{"enabled":true}"#, Some("http://evil.invalid")).0, 403);
        assert_eq!(request(&service, "POST", "/api/remote", &desktop, br#"{"enabled":true}"#, None).0, 200);
        let phone = service.data.lock().unwrap().phone_key.clone();
        let state: Value = serde_json::from_str(&request(&service, "GET", "/api/state", &phone, b"", None).1).unwrap();
        assert_eq!(state["desktop"], false); assert!(state.get("remote").is_none());
        assert_eq!(request(&service, "POST", "/api/command", &phone, br#"{"action":"play","id":"test-sound"}"#, None).0, 200);
        assert_eq!(calls.lock().unwrap()[0]["id"], "test-sound");
        assert_eq!(request(&service, "POST", "/api/command", &phone, br#"{"action":"play","id":"missing"}"#, None).0, 409);
        assert_eq!(request(&service, "POST", "/api/command", &phone, br#"{"action":"volume","volume":3}"#, None).0, 409);
        assert_eq!(request(&service, "POST", "/api/command", &phone, br#"{"action":"preview","id":"test-sound"}"#, None).0, 403);
        assert_eq!(request(&service, "POST", "/api/command", &phone, br#"{"action":"monitor","enabled":true}"#, None).0, 403);
        assert_eq!(request(&service, "POST", "/api/command", &phone, br#"{"action":"monitor-volume","volume":0.2}"#, None).0, 403);
        assert_eq!(request(&service, "POST", "/api/command", &desktop, br#"{"action":"monitor-volume","volume":2}"#, None).0, 409);
        assert_eq!(request(&service, "POST", "/api/remote", &phone, br#"{"enabled":false}"#, None).0, 403);
        assert_eq!(request(&service, "POST", "/api/network-access", &phone, b"", None).0, 403);
        assert_eq!(request(&service, "POST", "/api/upload", &desktop, b"RIFFtest", None).0, 200);
        assert!(service.uploads.lock().unwrap().is_empty());
        assert_eq!(request(&service, "POST", "/api/remote", &desktop, br#"{"enabled":false}"#, None).0, 200);
        assert_eq!(request(&service, "GET", "/api/state", &phone, b"", None).0, 401);
        service.shutdown();
    }
}
