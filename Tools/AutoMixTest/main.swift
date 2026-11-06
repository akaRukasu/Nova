// Test de l'analyse AutoMix (tempo, grille des temps, intro, fin, volume) sur des signaux connus
// puis sur de vraies musiques libres de droits (Kevin MacLeod, CC BY).
import AVFoundation
import Foundation

var failures = 0
func check(_ condition: Bool, _ message: String) {
    print("  \(condition ? "✓" : "✗") \(message)")
    if !condition { failures += 1 }
}

/// Rythme synthétique : grosse caisse sur chaque temps, caisse claire un temps sur deux, charleston entre les temps,
/// silence d'intro, fondu de fin et silence final.
func synth(bpm: Double, seconds: Double, intro: Double, fade: Double, seed: UInt64) -> [Float] {
    let rate = AudioAnalyzer.sampleRate
    var generator = SystemRandomNumberGenerator()
    _ = seed
    var y = [Float](repeating: 0, count: Int(seconds * rate))
    let beat = 60 / bpm
    var k = 0
    while true {
        let time = intro + Double(k) * beat
        if time > seconds { break }
        let start = Int(time * rate), length = Int(0.25 * rate)
        for i in 0..<length where start + i < y.count {
            let t = Double(i) / rate
            var v = sin(2 * .pi * (55 + 90 * exp(-t * 30)) * t) * exp(-t * 18)
            if k % 2 == 1 { v = v * 0.6 + Double.random(in: -0.5...0.5, using: &generator) * exp(-t * 25) }
            y[start + i] += Float(v)
        }
        let hat = Int((time + beat / 2) * rate)
        for i in 0..<Int(0.05 * rate) where hat + i < y.count {
            y[hat + i] += Float(Double.random(in: -0.15...0.15, using: &generator) * exp(-Double(i) / rate * 80))
        }
        k += 1
    }
    for i in y.indices {
        let t = Double(i) / rate
        if t > intro { y[i] += Float(0.08 * sin(2 * .pi * 220 * t)) }
        if fade > 0, t > seconds - fade { y[i] *= Float(pow(max(0, 1 - (t - (seconds - fade)) / fade), 2)) }
    }
    return y + [Float](repeating: 0, count: Int(2 * rate))
}

print("=== Signaux synthétiques")
for (bpm, fade) in [(124.0, 10.0), (97.0, 0.0), (128.0, 0.0), (110.0, 8.0), (93.5, 0.0)] {
    let started = Date()
    let a = AudioAnalyzer.analyze(samples: synth(bpm: bpm, seconds: 150, intro: 1, fade: fade, seed: 1))
    print(String(format: "%.1f BPM, fondu %.0f s → tempo %@, netteté %.2f, audible %.2f–%.2f, intro→%.2f, fin dès %.2f, niveau %.1f dB (%.2f s)",
                 bpm, fade, a.bpm.map { String(format: "%.2f", $0) } ?? "aucun", a.beatClarity, a.audibleStart, a.audibleEnd,
                 a.introEnd, a.outroStart, a.loudness, Date().timeIntervalSince(started)))
    let tempoOK = a.bpm.map { abs($0 - bpm) < 0.3 || abs($0 * 2 - bpm) < 0.6 || abs($0 / 2 - bpm) < 0.3 } ?? false
    check(tempoOK, "tempo trouvé (ou son double/moitié)")
    let period = 60 / bpm
    let phaseError = (a.beatNearStart - 1).truncatingRemainder(dividingBy: period)
    check(min(abs(phaseError), abs(period - abs(phaseError))) < 0.06, String(format: "grille des temps calée (écart %.3f s)", phaseError))
    check(abs(a.audibleStart - 1) < 0.1, "début audible après le silence d'intro")
    check(a.audibleEnd > 147 && a.audibleEnd < 151, "fin audible avant le silence final")
    if fade > 0 { check(a.outroStart > 150 - fade - 3 && a.outroStart < 150 - fade + 4, "début du fondu de fin repéré") }
}

print("\n=== Plan de transition (124 → 126 BPM)")
let a = AudioAnalyzer.analyze(samples: synth(bpm: 124, seconds: 150, intro: 1, fade: 0, seed: 2))
let b = AudioAnalyzer.analyze(samples: synth(bpm: 126, seconds: 150, intro: 2, fade: 0, seed: 3))
let plan = MixPlan.plan(outgoingID: "a", a, incomingID: "b", b)
print(String(format: "  départ %.2f s, durée %.2f s, entrée à %.2f s, vitesse %.4f, calé %@", plan.start, plan.duration, plan.incomingOffset, plan.incomingRate, plan.beatMatched ? "oui" : "non"))
check(plan.beatMatched, "tempos calés")
check(abs(plan.incomingRate - 124.0 / 126.0) < 0.003, "vitesse du titre entrant = rapport des tempos")
check(abs(plan.duration - 16 * 60 / 124) < 0.05, "16 temps de mélange")
check(plan.start + plan.duration <= a.audibleEnd + 0.6, "mélange terminé avant la fin du titre sortant")
check(abs(plan.incomingOffset - 2) < 0.08, "le titre entrant démarre sur son premier temps")

print("\n=== Vraies musiques (Kevin MacLeod, CC BY)")
let tracks = ["Monkeys Spinning Monkeys", "Sneaky Snitch", "Fluffing a Duck", "Investigations", "Local Forecast - Elevator", "Carefree", "Dreamer"]
for name in tracks {
    let url = URL(string: "https://incompetech.com/music/royalty-free/mp3-royaltyfree/\(name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)!).mp3")!
    guard let (data, response) = try? await URLSession.shared.data(from: url), (response as? HTTPURLResponse)?.statusCode == 200 else {
        print("  (\(name) : téléchargement impossible)")
        continue
    }
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("\(name).mp3")
    try data.write(to: file)
    let started = Date()
    do {
        let r = try await AudioAnalyzer.analyze(file: file)
        print(String(format: "  %@ : %@ BPM (netteté %.2f), audible %.1f–%.1f / %.1f s, intro→%.1f, fin dès %.1f, niveau %.1f dB, %.2f s de calcul",
                     name, r.bpm.map { String(format: "%.2f", $0) } ?? "—", r.beatClarity, r.audibleStart, r.audibleEnd, r.duration,
                     r.introEnd, r.outroStart, r.loudness, Date().timeIntervalSince(started)))
    } catch {
        print("  \(name) : analyse impossible (\(error))")
        failures += 1
    }
}

print("\nTerminé : \(failures) échec(s).")
exit(failures == 0 ? 0 : 1)
