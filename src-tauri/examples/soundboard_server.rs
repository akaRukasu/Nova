// Contrôleur de test : aucun compte Discord ni périphérique réel.
#[path = "../src/remote_server.rs"]
mod remote_server;
#[path = "../src/myinstants.rs"]
mod myinstants;
use remote_server::{Board, Service, Sound};
use serde_json::json;
use std::{sync::{Arc, Mutex}, thread, time::Duration};

fn main() {
    let names = ["Airhorn", "Applaudissements", "Suspense", "Victoire", "Petit rire", "Surprise", "Mission réussie", "Oh non", "Retour au calme", "Batterie", "Chat curieux", "À bientôt"];
    let colors = ["#7c6bff", "#4ab9be", "#df9e5b", "#cf719e", "#83b77a", "#6b9be2"];
    let board = Arc::new(Mutex::new(Board { active: true, enabled: true, sounds: names.iter().enumerate().map(|(i,name)| Sound {
        id: format!("fixture-{i}"), name: name.to_string(), local: i % 2 == 0, favorite: i < 3,
        category: if i % 3 == 0 { "Réactions".into() } else { "".into() }, color: colors[i % colors.len()].into(),
        shortcut: if i < 4 { format!("F{}", i+5) } else { String::new() },
        source_slug: String::new(),
    }).collect(), ..Board::default() }));
    let catalog = myinstants::Catalog::with_fetch(Arc::new(|url,_| {
        if url.contains("/api/v1/") { return Ok(serde_json::to_vec(&json!({"count":2,"next":null,"results":[{"name":"Myinstants test","slug":"fixture-horn","sound":"https://www.myinstants.com/media/sounds/fixture-horn.mp3","color":"7C6BFF"},{"name":"Myinstants mobile","slug":"fixture-phone","sound":"https://www.myinstants.com/media/sounds/fixture-phone.mp3","color":"4AB9BE"}]})).unwrap()); }
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF"); wav.extend_from_slice(&1636u32.to_le_bytes()); wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes()); wav.extend_from_slice(&1u16.to_le_bytes()); wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&8000u32.to_le_bytes()); wav.extend_from_slice(&16000u32.to_le_bytes()); wav.extend_from_slice(&2u16.to_le_bytes()); wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data"); wav.extend_from_slice(&1600u32.to_le_bytes()); wav.resize(1644,0); Ok(wav)
    }));
    let service = Arc::new(Service::with_myinstants(catalog));
    service.sync(board.lock().unwrap().clone()).unwrap();
    let callback = service.clone(); let model = board.clone();
    let url = service.start(Arc::new(move |action| {
        let mut board = model.lock().unwrap();
        match action["action"].as_str().unwrap() {
            "play" => board.last_playback = format!("Son envoyé : {}", action["id"].as_str().unwrap()),
            "preview" => board.last_playback = "Écoute locale".into(),
            "volume" => board.volume = action["volume"].as_f64().unwrap(),
            "monitor" => board.monitor = action["enabled"].as_bool().unwrap(),
            "monitor-volume" => board.monitor_volume = action["volume"].as_f64().unwrap(),
            "enable" => board.enabled = action["enabled"].as_bool().unwrap(),
            "stop" => board.last_playback = "Sons arrêtés".into(),
            "online-prepare" => {},
            "online-sound" => {
                callback.take_upload(action["upload_id"].as_str().unwrap())?;
                let slug = action["slug"].as_str().unwrap();
                if action["mode"] == "play" || action["mode"] == "preview" { board.last_playback = format!("Myinstants joué : {slug}"); }
                else if !board.sounds.iter().any(|sound| sound.source_slug == slug) {
                    board.sounds.push(Sound { id: format!("saved-{slug}"), name: action["name"].as_str().unwrap().into(), local: true, source_slug: slug.into(), category:"Myinstants".into(), ..Sound::default() });
                }
            },
            "delete" => board.sounds.retain(|sound| Some(sound.id.as_str()) != action["id"].as_str()),
            "edit" => {
                if let Some(sound) = board.sounds.iter_mut().find(|sound| Some(sound.id.as_str()) == action["id"].as_str()) {
                    if let Some(value) = action["name"].as_str() { sound.name = value.into(); }
                    if let Some(value) = action["category"].as_str() { sound.category = value.into(); }
                    if let Some(value) = action["favorite"].as_bool() { sound.favorite = value; }
                    if let Some(value) = action["color"].as_str() { sound.color = value.into(); }
                }
            },
            "import" => {
                let bytes = callback.take_upload(action["upload_id"].as_str().unwrap())?;
                if bytes.is_empty() { return Err("Fichier vide".into()); }
                board.sounds.push(Sound { id: "imported-fixture".into(), name: "test.wav".into(), local: true, ..Sound::default() });
            },
            _ => {},
        }
        callback.sync(board.clone())?;
        callback.complete(action["requestId"].as_str().unwrap(), None); Ok(())
    })).unwrap();
    println!("{}", json!({"url":url}));
    loop { thread::sleep(Duration::from_secs(1)); service.sync(board.lock().unwrap().clone()).unwrap(); }
}
