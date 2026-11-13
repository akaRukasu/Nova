import Accelerate
import AVFoundation
import Foundation

/// Ce que Nova sait d'un titre pour l'enchaîner comme un DJ : tempo, grille des temps,
/// début et fin audibles, intro, début de la fin (fondu, outro) et niveau sonore.
struct TrackAnalysis: Codable, Sendable, Equatable {
    static let currentVersion = 1
    var version = TrackAnalysis.currentVersion
    var duration: Double
    /// Tempo (battements par minute) ; `nil` quand la pulsation n'est pas nette (ambiant, piano libre…).
    var bpm: Double?
    /// Netteté de la pulsation (rapport entre la grille trouvée et une grille au hasard).
    var beatClarity: Double
    /// Un temps de la grille près du début, et un près de la fin (le tempo peut légèrement varier).
    var beatNearStart: Double
    var beatNearEnd: Double
    /// Premier et dernier instant où l'on entend quelque chose (silences de début et de fin exclus).
    var audibleStart: Double
    var audibleEnd: Double
    /// Fin de l'intro calme, début de la partie finale (fondu de fin, outro plus calme).
    var introEnd: Double
    var outroStart: Double
    /// Niveau du corps du morceau (dB, valeur efficace) : sert à égaliser le volume entre les titres.
    var loudness: Double

    var beatPeriod: Double? { bpm.map { 60 / $0 } }

    private func anchor(for time: Double) -> Double { time < duration / 2 ? beatNearStart : beatNearEnd }

    /// Temps de la grille le plus proche de `time`.
    func nearestBeat(to time: Double) -> Double {
        guard let period = beatPeriod else { return time }
        let anchor = anchor(for: time)
        return anchor + ((time - anchor) / period).rounded() * period
    }

    /// Premier temps de la grille à partir de `time`.
    func beat(onOrAfter time: Double) -> Double {
        guard let period = beatPeriod else { return time }
        let anchor = anchor(for: time)
        return anchor + ((time - anchor) / period - 0.02).rounded(.up) * period
    }
}

enum AudioAnalyzer {
    /// Basse résolution : largement suffisante pour le rythme et le volume, et peu coûteuse.
    static let sampleRate = 11025.0
    static let hop = 256
    static let size = 512

    static func analyze(file: URL) async throws -> TrackAnalysis {
        let samples = try await decode(file)
        guard samples.count > size * 200 else { throw NovaError.noPlayableStream }
        return analyze(samples: samples)
    }

    /// Fichier audio → échantillons mono à 11 025 Hz.
    static func decode(_ file: URL) async throws -> [Float] {
        let asset = AVURLAsset(url: file)
        guard let track = try await asset.loadTracks(withMediaType: .audio).first else { throw NovaError.noPlayableStream }
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ])
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { throw NovaError.noPlayableStream }
        reader.add(output)
        guard reader.startReading() else { throw reader.error ?? NovaError.noPlayableStream }
        var samples: [Float] = []
        samples.reserveCapacity(Int(sampleRate) * 300)
        while let buffer = output.copyNextSampleBuffer() {
            if let block = CMSampleBufferGetDataBuffer(buffer) {
                let count = CMBlockBufferGetDataLength(block) / MemoryLayout<Float>.size
                let start = samples.count
                samples.append(contentsOf: repeatElement(0, count: count))
                samples.withUnsafeMutableBytes { raw in
                    _ = CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: count * MemoryLayout<Float>.size,
                                                   destination: raw.baseAddress! + start * MemoryLayout<Float>.size)
                }
            }
            CMSampleBufferInvalidate(buffer)
        }
        if reader.status == .failed { throw reader.error ?? NovaError.noPlayableStream }
        return samples
    }

    // MARK: Analyse

    static func analyze(samples: [Float]) -> TrackAnalysis {
        let frameRate = sampleRate / Double(hop)
        let frames = max(1, (samples.count - size) / hop + 1)
        let (rms, flux) = spectralFlux(samples, frames: frames)
        let time = { (frame: Int) in Double(frame) / frameRate }
        let duration = Double(samples.count) / sampleRate

        // Parties audibles : au-dessus de -45 dB sous le maximum.
        let db = rms.map { 20 * log10(max(Double($0), 1e-9)) }
        let peak = db.max() ?? 0
        let firstAudible = db.firstIndex { $0 > peak - 45 } ?? 0
        let lastAudible = db.lastIndex { $0 > peak - 45 } ?? frames - 1
        let audibleStart = time(firstAudible)
        let audibleEnd = min(duration, time(lastAudible) + Double(size) / sampleRate)

        // Niveau lissé sur une seconde : corps du morceau, intro et fin plus calmes.
        let width = max(1, Int(frameRate))
        let smooth = movingAverage(rms.map { Double($0 * $0) }, width: width).map { 10 * log10(max($0, 1e-12)) }
        let body = percentile(Array(smooth[firstAudible...max(firstAudible, lastAudible)]), 0.7)
        let firstLoud = smooth.indices.first { $0 >= firstAudible && smooth[$0] >= body - 6 } ?? firstAudible
        let lastLoud = smooth.indices.last { $0 <= lastAudible && smooth[$0] >= body - 6 } ?? lastAudible

        // Attaques (grosse caisse, caisse claire…) : flux spectral débarrassé de sa moyenne locale.
        let average = movingAverage(flux.map(Double.init), width: width)
        let onsets = zip(flux, average).map { max(0, Double($0) - $1) }
        let (bpm, clarity) = tempo(onsets, frameRate: frameRate)

        var beatNearStart = audibleStart, beatNearEnd = max(audibleStart, audibleEnd - 30)
        if let bpm {
            let period = 60 * frameRate / bpm
            beatNearStart = phase(onsets, period: period, from: firstAudible, to: min(lastAudible, firstAudible + Int(30 * frameRate))) / frameRate
            beatNearEnd = phase(onsets, period: period, from: max(firstAudible, lastAudible - Int(30 * frameRate)), to: lastAudible) / frameRate
        }
        return TrackAnalysis(duration: duration, bpm: bpm, beatClarity: clarity,
                             beatNearStart: beatNearStart, beatNearEnd: beatNearEnd,
                             audibleStart: audibleStart, audibleEnd: audibleEnd,
                             introEnd: time(firstLoud), outroStart: time(lastLoud), loudness: body)
    }

    /// Niveau (valeur efficace) et flux spectral de chaque tranche de 23 ms ; les basses (sous 250 Hz) comptent triple.
    private static func spectralFlux(_ samples: [Float], frames: Int) -> (rms: [Float], flux: [Float]) {
        let half = size / 2
        let log2n = vDSP_Length(9)
        guard let setup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2)) else { return ([], []) }
        defer { vDSP_destroy_fftsetup(setup) }
        var window = [Float](repeating: 0, count: size)
        vDSP_hann_window(&window, vDSP_Length(size), Int32(vDSP_HANN_NORM))
        let binHz = sampleRate / Double(size)
        let weights = (0..<half).map { Float(Double($0) * binHz < 250 ? 3 : 1) }
        var frame = [Float](repeating: 0, count: size)
        var real = [Float](repeating: 0, count: half)
        var imag = [Float](repeating: 0, count: half)
        var magnitude = [Float](repeating: 0, count: half)
        var previous = [Float](repeating: 0, count: half)
        var rms = [Float](repeating: 0, count: frames)
        var flux = [Float](repeating: 0, count: frames)
        samples.withUnsafeBufferPointer { input in
            guard let start = input.baseAddress, input.count >= size else { return }
            for f in 0..<frames {
                let base = start + f * hop
                var level: Float = 0
                vDSP_rmsqv(base, 1, &level, vDSP_Length(size))
                rms[f] = level
                vDSP_vmul(base, 1, window, 1, &frame, 1, vDSP_Length(size))
                real.withUnsafeMutableBufferPointer { realPointer in
                    imag.withUnsafeMutableBufferPointer { imagPointer in
                        var split = DSPSplitComplex(realp: realPointer.baseAddress!, imagp: imagPointer.baseAddress!)
                        frame.withUnsafeBufferPointer { framePointer in
                            framePointer.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: half) {
                                vDSP_ctoz($0, 2, &split, 1, vDSP_Length(half))
                            }
                        }
                        vDSP_fft_zrip(setup, &split, 1, log2n, FFTDirection(FFT_FORWARD))
                        // Composantes continue et de Nyquist rangées ensemble : ignorées.
                        split.realp[0] = 0
                        split.imagp[0] = 0
                        vDSP_zvabs(&split, 1, &magnitude, 1, vDSP_Length(half))
                    }
                }
                var sum: Float = 0
                for i in 1..<half {
                    let value = log1pf(50 * magnitude[i])
                    let rise = value - previous[i]
                    if f > 0, rise > 0 { sum += rise * weights[i] }
                    previous[i] = value
                }
                flux[f] = sum
            }
        }
        return (rms, flux)
    }

    /// Tempo : autocorrélation des attaques (avec ses multiples, et une préférence autour de 120 BPM),
    /// puis raffinement au centième en calant une grille sur tout le morceau.
    private static func tempo(_ onsets: [Double], frameRate: Double) -> (bpm: Double?, clarity: Double) {
        let count = onsets.count
        let maxLag = Int(60 * frameRate / 70 * 4) + 6
        guard count > maxLag * 3 else { return (nil, 0) }
        let mean = onsets.reduce(0, +) / Double(count)
        let centered = onsets.map { $0 - mean }
        var correlation = [Double](repeating: 0, count: maxLag + 2)
        centered.withUnsafeBufferPointer { pointer in
            for lag in 0..<correlation.count {
                var dot = 0.0
                vDSP_dotprD(pointer.baseAddress!, 1, pointer.baseAddress! + lag, 1, &dot, vDSP_Length(count - lag))
                correlation[lag] = dot
            }
        }
        func value(at lag: Double) -> Double {
            let i = Int(lag), f = lag - Double(i)
            guard i + 1 < correlation.count else { return 0 }
            return correlation[i] * (1 - f) + correlation[i + 1] * f
        }
        var best = (score: -Double.infinity, bpm: 120.0)
        for bpm in stride(from: 70.0, through: 180.0, by: 0.5) {
            let period = 60 * frameRate / bpm
            let comb = value(at: period) + 0.5 * value(at: 2 * period) + 0.33 * value(at: 3 * period) + 0.25 * value(at: 4 * period)
            let prior = exp(-0.5 * pow(log2(bpm / 120), 2))
            if comb * prior > best.score { best = (comb * prior, bpm) }
        }
        guard best.score > 0 else { return (nil, 0) }

        var refined = (score: -Double.infinity, bpm: best.bpm)
        for bpm in stride(from: best.bpm - 1.5, through: best.bpm + 1.5, by: 0.02) {
            let period = 60 * frameRate / bpm
            var phase = 0.0
            while phase < period {
                let score = gridSum(onsets, period: period, start: phase, end: count)
                if score > refined.score { refined = (score, bpm) }
                phase += 0.5
            }
        }
        // Netteté : grille trouvée comparée à la moyenne des grilles décalées.
        let period = 60 * frameRate / refined.bpm
        var sums: [Double] = []
        var phase = 0.0
        while phase < period {
            sums.append(gridSum(onsets, period: period, start: phase, end: count))
            phase += 0.5
        }
        let clarity = (sums.max() ?? 0) / max(sums.reduce(0, +) / Double(max(sums.count, 1)), 1e-9)
        return (clarity >= 1.8 ? refined.bpm : nil, clarity)
    }

    /// Somme des attaques aux positions start, start + period, start + 2·period… (interpolées).
    private static func gridSum(_ onsets: [Double], period: Double, start: Double, end: Int) -> Double {
        var sum = 0.0
        var position = start
        let last = Double(min(end, onsets.count) - 1)
        while position < last {
            let i = Int(position), f = position - Double(i)
            sum += onsets[i] * (1 - f) + onsets[i + 1] * f
            position += period
        }
        return sum
    }

    /// Position (en tranches) d'un temps de la grille entre `from` et `to`.
    private static func phase(_ onsets: [Double], period: Double, from: Int, to: Int) -> Double {
        var best = (score: -Double.infinity, phase: 0.0)
        var phase = 0.0
        while phase < period {
            let score = gridSum(onsets, period: period, start: Double(from) + phase, end: max(to, from + 1))
            if score > best.score { best = (score, phase) }
            phase += 0.25
        }
        return Double(from) + best.phase
    }

    private static func movingAverage(_ values: [Double], width: Int) -> [Double] {
        guard !values.isEmpty else { return [] }
        var prefix = [Double](repeating: 0, count: values.count + 1)
        for (i, value) in values.enumerated() { prefix[i + 1] = prefix[i] + value }
        let half = width / 2
        return values.indices.map { i in
            let low = max(0, i - half), high = min(values.count, i + half + 1)
            return (prefix[high] - prefix[low]) / Double(high - low)
        }
    }

    private static func percentile(_ values: [Double], _ fraction: Double) -> Double {
        guard !values.isEmpty else { return -60 }
        let sorted = values.sorted()
        return sorted[min(sorted.count - 1, Int(Double(sorted.count - 1) * fraction))]
    }
}

/// Analyses gardées en mémoire et sur le disque (une seule fois par titre), calculées une à la fois.
actor AnalysisStore {
    static let shared = AnalysisStore()

    private var memory: [String: TrackAnalysis] = [:]
    private var running: [String: Task<TrackAnalysis?, Never>] = [:]
    private let directory: URL

    init() {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        directory = caches.appendingPathComponent("Analyses", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    /// Analyse déjà faite (mémoire ou disque), sans rien calculer.
    func cached(_ id: String) -> TrackAnalysis? {
        if let known = memory[id] { return known }
        let file = directory.appendingPathComponent("\(id).json")
        guard let data = try? Data(contentsOf: file),
              let saved = try? JSONDecoder().decode(TrackAnalysis.self, from: data),
              saved.version == TrackAnalysis.currentVersion else { return nil }
        memory[id] = saved
        return saved
    }

    /// Analyse du fichier local d'un titre (calculée si besoin, en arrière-plan).
    func analysis(for id: String, file: URL) async -> TrackAnalysis? {
        if let known = cached(id) { return known }
        if let task = running[id] { return await task.value }
        // Une analyse à la fois : le processeur reste disponible pour la lecture.
        for (_, other) in running { _ = await other.value }
        if let known = cached(id) { return known }
        let task = Task.detached(priority: .utility) { try? await AudioAnalyzer.analyze(file: file) }
        running[id] = task
        let result = await task.value
        running[id] = nil
        if let result {
            memory[id] = result
            if let data = try? JSONEncoder().encode(result) {
                try? data.write(to: directory.appendingPathComponent("\(id).json"), options: .atomic)
            }
        }
        return result
    }
}

/// Transition préparée entre deux titres analysés.
struct MixPlan: Sendable, Equatable {
    let outgoingID: String
    let incomingID: String
    /// Instant du titre sortant où le titre entrant démarre (calé sur un temps).
    let start: Double
    /// Durée du mélange.
    let duration: Double
    /// Position de départ du titre entrant (premier temps après son silence d'intro).
    let incomingOffset: Double
    /// Vitesse du titre entrant pendant le mélange (tempo calé sur le sortant, hauteur conservée), puis retour à 1.
    let incomingRate: Double
    /// Les temps des deux titres tombent ensemble.
    let beatMatched: Bool
    /// Égaliseur de volume (1 = inchangé).
    let outgoingGain: Double
    let incomingGain: Double

    /// Courbe douce avec une somme de gains plafonnée pendant le recouvrement.
    static func volumes(at t: Double) -> (incoming: Double, outgoing: Double) {
        let x = min(max(t, 0), 1)
        let u = x * x * (3 - 2 * x)
        return (u, 1 - u)
    }

    /// Gain de l'égaliseur de volume : les titres plus forts que la cible sont baissés (jamais montés).
    static func gain(for analysis: TrackAnalysis?) -> Double {
        guard PlaybackSettings.normalizeVolume, let analysis else { return 1 }
        return min(1, pow(10, (PlaybackSettings.loudnessTarget - analysis.loudness) / 20))
    }

    static func plan(outgoingID: String, _ a: TrackAnalysis, incomingID: String, _ b: TrackAnalysis) -> MixPlan {
        // Tempo : rapport ramené près de 1 (un titre à 70 se cale sur un titre à 140) ; calé si l'écart reste faible.
        var rate = 1.0
        var matched = false
        if let tempoA = a.bpm, let tempoB = b.bpm {
            var ratio = tempoA / tempoB
            while ratio > 1.41 { ratio /= 2 }
            while ratio < 0.71 { ratio *= 2 }
            if abs(ratio - 1) <= 0.08 {
                rate = ratio
                matched = true
            }
        }

        // Durée : 16 temps (souvent 4 mesures), entre 6 et 14 s ; sinon un fondu de 8 s.
        var duration = 8.0
        if matched, let period = a.beatPeriod {
            duration = 16 * period
            if duration < 6 { duration = 32 * period }
            if duration > 14 { duration = 8 * period }
        }

        // Fin du titre sortant : on mélange pendant son fondu de fin s'il en a un, sinon juste avant son dernier son.
        let fadeLength = a.audibleEnd - a.outroStart
        var start: Double
        if fadeLength >= 4 {
            start = a.outroStart - (matched ? duration * 0.25 : 0)
            duration = min(max(duration, min(fadeLength, 14)), a.audibleEnd - start)
        } else {
            start = a.audibleEnd - duration
        }
        // Jamais trop tôt dans le morceau.
        start = max(start, min(a.audibleEnd - 4, max(20, a.duration * 0.5)))
        if matched { start = a.nearestBeat(to: start) }
        duration = max(3, min(duration, a.audibleEnd - start + 0.5))

        // Début du titre entrant : son premier temps, une fois le silence d'intro passé.
        var offset = max(0, b.audibleStart - 0.02)
        if matched, b.bpm != nil {
            offset = max(0, b.beat(onOrAfter: b.audibleStart - 0.05))
            if offset - b.audibleStart > 2 { offset = max(0, b.audibleStart - 0.02) }
        }
        return MixPlan(outgoingID: outgoingID, incomingID: incomingID, start: start, duration: duration,
                       incomingOffset: offset, incomingRate: rate, beatMatched: matched,
                       outgoingGain: gain(for: a), incomingGain: gain(for: b))
    }
}
