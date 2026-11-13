import Foundation
import MediaPlayer
import Observation
import UIKit

/// Importe des playlists venues d'ailleurs : chaque titre est retrouvé sur YouTube Music,
/// puis la playlist est créée (ou remplacée) dans la bibliothèque de Nova.
@MainActor
@Observable
final class ImportManager {
    struct Job: Identifiable, Codable {
        var id = UUID()
        var name: String
        var source: String
        var total: Int
        var processed = 0
        var matched = 0
        var missing: [ImportedTrack] = []
        var octaveMissing: [ImportedTrack] = []
        var diagnostics: [String: String] = [:]
        var attempts: [String: Int] = [:]
        var fallbacks: [String: Track] = [:]

        var reviewTracks: [ImportedTrack] {
            var seen = Set<String>()
            return (missing + octaveMissing).filter { seen.insert($0.id).inserted }
        }
        /// Deuxième passage, plus lent, sur les titres introuvables (le réseau ou YouTube ont pu échouer).
        var verifying = false
        /// Bilan : ajoutés, déjà présents (rien n'est doublé), doublons dans la liste d'origine.
        var added = 0
        var alreadyPresent = 0
        var duplicates = 0
        var isFinished = false
        var isCancelled = false
        var error: String?
        /// Playlist Nova créée, ou titres likés.
        var playlistID: UUID?
        var isLiked = false
        var startedAt = Date()

        var progress: Double { total > 0 ? Double(processed) / Double(total) : 0 }

        /// Temps restant estimé, d'après le rythme actuel.
        var remaining: TimeInterval? {
            guard processed >= 10, processed < total else { return nil }
            let rate = Date().timeIntervalSince(startedAt) / Double(processed)
            return rate * Double(total - processed)
        }
    }

    private(set) var jobs: [Job] = []
    /// Jeton de l'API web Spotify, récupéré à la connexion (valable environ une heure).
    var spotifyToken: String?

    @ObservationIgnored private let journalFile: URL
    @ObservationIgnored private var journalSave: Task<Void, Never>?

    init() {
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Nova", isDirectory: true)
        journalFile = directory.appendingPathComponent("import-journal.json")
        if let data = try? Data(contentsOf: journalFile), let saved = try? JSONDecoder().decode([Job].self, from: data) {
            jobs = saved.map { value in
                var job = value
                if !job.isFinished {
                    job.isCancelled = true
                    job.isFinished = true
                    job.error = "Import interrompu. Les titres du journal peuvent être recherchés de nouveau."
                }
                return job
            }
        }
    }

    private func saveJournal() {
        journalSave?.cancel()
        journalSave = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard let self, !Task.isCancelled else { return }
            do {
                try FileManager.default.createDirectory(at: journalFile.deletingLastPathComponent(), withIntermediateDirectories: true)
                try JSONEncoder().encode(jobs).write(to: journalFile, options: .atomic)
            } catch {
                for index in jobs.indices {
                    jobs[index].error = "Journal non enregistré. " + error.localizedDescription
                }
            }
        }
    }

    @ObservationIgnored private let client = InnerTubeClient()
    @ObservationIgnored private var tasks: [UUID: Task<Void, Never>] = [:]
    @ObservationIgnored private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    /// Recherches en parallèle (YouTube Music tolère bien ce rythme).
    private let parallel = 6

    var isRunning: Bool { jobs.contains { !$0.isFinished } }

    func job(_ id: UUID) -> Job? { jobs.first { $0.id == id } }

    func start(_ playlists: [ImportedPlaylist], into library: LibraryStore) {
        beginBackgroundTime()
        for playlist in playlists {
            let job = Job(name: playlist.name, source: playlist.source.components(separatedBy: ":").first ?? playlist.source,
                          total: playlist.count, isLiked: playlist.isLiked)
            jobs.insert(job, at: 0)
            saveJournal()
            let id = job.id
            tasks[id] = Task { await run(playlist, jobID: id, library: library) }
        }
    }

    func cancel(_ id: UUID) {
        tasks[id]?.cancel()
        update(id) {
            $0.isCancelled = true
            $0.isFinished = true
        }
    }

    func clearFinished() {
        jobs.removeAll { $0.isFinished && $0.reviewTracks.isEmpty }
        saveJournal()
    }

    private func update(_ id: UUID, _ change: (inout Job) -> Void) {
        guard let index = jobs.firstIndex(where: { $0.id == id }) else { return }
        change(&jobs[index])
        saveJournal()
    }

    private func run(_ source: ImportedPlaylist, jobID: UUID, library: LibraryStore) async {
        var playlist = source
        do {
            if playlist.tracks.isEmpty, playlist.youTubeTracks == nil {
                playlist.tracks = try await loadTracks(of: playlist)
            }
        } catch {
            update(jobID) {
                $0.error = error.localizedDescription
                $0.isFinished = true
            }
            finishIfIdle()
            return
        }

        var found: [Track] = []
        if let tracks = playlist.youTubeTracks {
            update(jobID) {
                $0.total = tracks.count
                $0.startedAt = Date()
            }
            for track in tracks {
                if job(jobID)?.isCancelled == true { break }
                let recording = await Self.resolveOctave(track)
                found.append(recording ?? track)
                update(jobID) { job in
                    job.processed += 1
                    job.matched += 1
                    if recording == nil {
                        let original = ImportedTrack(title: track.title, artist: track.artist, album: track.album, duration: track.duration)
                        job.octaveMissing.append(original)
                        job.attempts[original.id, default: 0] += 1
                        job.diagnostics[original.id] = "Importé sur YouTube. Aucune correspondance Octave confirmée."
                        job.fallbacks[original.id] = track
                    }
                }
            }
            let pending = job(jobID)?.octaveMissing ?? []
            if !pending.isEmpty, job(jobID)?.isCancelled != true {
                update(jobID) { $0.octaveMissing = []; $0.verifying = true }
                let verified = await match(pending, jobID: jobID, width: 2, verifying: true, countNewMatches: [])
                var corrected: [String: Track] = [:]
                for result in verified.compactMap({ $0 }) {
                    if let id = result.youtubeID, result.id.hasPrefix("octave:") { corrected[id] = result }
                }
                found = found.map { corrected[$0.id] ?? $0 }
                update(jobID) { $0.verifying = false }
            }
        } else {
            let tracks = playlist.tracks
            update(jobID) {
                $0.total = tracks.count
                $0.startedAt = Date()
            }
            var results = await match(tracks, jobID: jobID, width: parallel)
            // Vérification : les introuvables sont recherchés une seconde fois, plus lentement.
            let missingPositions = results.indices.filter { results[$0]?.id.hasPrefix("octave:") != true }
            let notYetMatched = Set(results.indices.filter { results[$0] == nil }.map { tracks[$0].id })
            if !missingPositions.isEmpty, job(jobID)?.isCancelled != true {
                update(jobID) {
                    $0.verifying = true
                    $0.missing = []
                    $0.octaveMissing = []
                }
                let second = await match(missingPositions.map { tracks[$0] }, jobID: jobID, width: 2, verifying: true,
                                         countNewMatches: notYetMatched)
                for (offset, position) in missingPositions.enumerated() { results[position] = second[offset] }
                update(jobID) { $0.verifying = false }
            }
            found = results.compactMap { $0 }
        }
        guard job(jobID)?.isCancelled != true else { finishIfIdle(); return }

        let outcome = playlist.isLiked ? library.importIntoLiked(found)
            : found.isEmpty ? LibraryStore.ImportOutcome() : library.importIntoPlaylist(name: playlist.name, tracks: found)
        update(jobID) {
            $0.playlistID = outcome.playlistID ?? $0.playlistID
            $0.added = outcome.added
            $0.alreadyPresent = outcome.alreadyPresent
            $0.duplicates = outcome.duplicates
            $0.isFinished = true
        }
        await MatchCache.shared.flush()
        finishIfIdle()
    }

    /// Recherche les titres (dans l'ordre), `width` à la fois, en mettant à jour l'avancement.
    /// `verifying` : second passage sur des titres déjà comptés (seuls les trouvés changent les chiffres).
    private struct MatchResult: Sendable {
        let track: Track?
        let octaveIssue: String?
    }

    private func match(_ tracks: [ImportedTrack], jobID: UUID, width: Int, verifying: Bool = false,
                       countNewMatches: Set<String>? = nil) async -> [Track?] {
        var results = [Track?](repeating: nil, count: tracks.count)
        let client = self.client
        await withTaskGroup(of: (Int, MatchResult).self) { group in
            let first = min(width, tracks.count)
            for index in 0..<first {
                group.addTask { (index, await Self.matchImported(tracks[index], client: client)) }
            }
            var nextIndex = first
            for await (index, match) in group {
                let wanted = tracks[index]
                let fallback = job(jobID)?.fallbacks[wanted.id]
                var track = match.track ?? fallback
                if track?.id.hasPrefix("octave:") == true, let fallback { track?.youtubeID = fallback.id }
                results[index] = track
                update(jobID) { job in
                    if !verifying { job.processed += 1 }
                    if track != nil, (countNewMatches?.contains(wanted.id) ?? true) { job.matched += 1 }
                    if track == nil { job.missing.append(wanted) }
                    job.attempts[wanted.id, default: 0] += 1
                    if track?.id.hasPrefix("octave:") != true {
                        job.octaveMissing.append(wanted)
                        job.diagnostics[wanted.id] = match.octaveIssue ?? "Aucune correspondance Octave confirmée."
                        if let track { job.fallbacks[wanted.id] = track }
                    } else {
                        job.diagnostics[wanted.id] = "Correspondance Octave confirmée."
                    }
                }
                if job(jobID)?.isCancelled == true {
                    group.cancelAll()
                    break
                }
                if nextIndex < tracks.count {
                    let next = nextIndex
                    group.addTask { (next, await Self.matchImported(tracks[next], client: client)) }
                    nextIndex += 1
                }
            }
        }
        return results
    }

    nonisolated static func resolveOctave(_ track: Track) async -> Track? {
        guard var recording = try? await OctaveCatalog.shared.recording(track) else { return nil }
        recording.youtubeID = track.youtubeID ?? (track.id.hasPrefix("octave:") ? nil : track.id)
        recording.artworkURL = recording.artworkURL ?? track.artworkURL
        return recording
    }

    private nonisolated static func matchImported(_ wanted: ImportedTrack, client: InnerTubeClient) async -> MatchResult {
        let query = Track(id: "import:" + wanted.id, title: wanted.title, artist: wanted.artist, album: wanted.album, duration: wanted.duration)
        var reason = "Aucune correspondance Octave confirmée après vérification du titre, des artistes et de la durée."
        do {
            if let result = try await OctaveCatalog.shared.recording(query) { return MatchResult(track: result, octaveIssue: nil) }
        } catch {
            reason = error.localizedDescription
        }
        return MatchResult(track: await TrackMatcher.match(wanted, client: client), octaveIssue: reason)
    }

    /// Relance la recherche des titres introuvables (le réseau ou YouTube ont pu échouer).
    func retryMissing(_ id: UUID, library: LibraryStore) {
        guard let current = job(id), current.isFinished, !current.reviewTracks.isEmpty else { return }
        let missing = current.reviewTracks
        let newMatches = Set(current.missing.map(\.id))
        update(id) {
            $0.missing = []
            $0.octaveMissing = []
            $0.isFinished = false
            $0.isCancelled = false
            $0.error = nil
            $0.verifying = true
            $0.startedAt = Date()
        }
        beginBackgroundTime()
        tasks[id] = Task {
            let found = await match(missing, jobID: id, width: 2, verifying: true, countNewMatches: newMatches).compactMap { $0 }
            add(found, toJob: id, library: library)
            update(id) { $0.isFinished = true; $0.verifying = false }
            await MatchCache.shared.flush()
            finishIfIdle()
        }
    }

    /// Correction à la main : le titre choisi remplace l'introuvable.
    func resolve(_ missing: ImportedTrack, with track: Track, inJob id: UUID, library: LibraryStore) {
        var recording = track
        if recording.id.hasPrefix("octave:") { recording.youtubeID = job(id)?.fallbacks[missing.id]?.id }
        add([recording], toJob: id, library: library)
        update(id) { job in
            if let index = job.missing.firstIndex(of: missing) {
                job.missing.remove(at: index)
                job.matched += 1
            }
            job.octaveMissing.removeAll { $0.id == missing.id }
            job.diagnostics[missing.id] = "Correspondance choisie manuellement."
        }
        Task { await MatchCache.shared.store(track, for: missing); await MatchCache.shared.flush() }
    }

    private func add(_ tracks: [Track], toJob id: UUID, library: LibraryStore) {
        guard !tracks.isEmpty, let job = job(id) else { return }
        let outcome: LibraryStore.ImportOutcome
        if job.isLiked {
            outcome = library.importIntoLiked(tracks)
        } else if let playlistID = job.playlistID, let name = library.playlist(playlistID)?.name {
            outcome = library.importIntoPlaylist(name: name, tracks: tracks)
        } else {
            outcome = library.importIntoPlaylist(name: job.name, tracks: tracks)
        }
        update(id) {
            $0.playlistID = outcome.playlistID ?? $0.playlistID
            $0.added += outcome.added
            $0.alreadyPresent += outcome.alreadyPresent
        }
    }

    // MARK: Arrière-plan

    /// Demande à iOS quelques instants de plus quand l'app passe en arrière-plan pendant un import.
    private func beginBackgroundTime() {
        guard backgroundTask == .invalid else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Import Nova") { [weak self] in
            // Rendu tout de suite (sur le fil principal) : sinon iOS ferme l'app.
            MainActor.assumeIsolated { self?.endBackgroundTime() }
        }
    }

    private func finishIfIdle() {
        if !isRunning { endBackgroundTime() }
    }

    private func endBackgroundTime() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    /// Titres d'une playlist annoncée par un compte (chargés au moment de l'import).
    private func loadTracks(of playlist: ImportedPlaylist) async throws -> [ImportedTrack] {
        let parts = playlist.source.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { throw ImportError.nothingFound }
        switch parts[0] {
        case "Spotify":
            guard let token = spotifyToken else { throw ImportError.http(401, "Spotify") }
            return try await ImportSources.spotifyPlaylistTracks(id: parts[1], token: token)
        case "Deezer":
            return try await ImportSources.deezerPlaylistTracks(id: parts[1])
        default:
            throw ImportError.nothingFound
        }
    }

    // MARK: - Apple Music (bibliothèque de l'iPhone)

    static func appleMusicLibrary() async throws -> [ImportedPlaylist] {
        let status = await withCheckedContinuation { continuation in
            MPMediaLibrary.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard status == .authorized else { throw AppleMusicError.denied }

        func imported(_ items: [MPMediaItem]) -> [ImportedTrack] {
            items.compactMap { item in
                guard let title = item.title, !title.isEmpty else { return nil }
                return ImportedTrack(title: title, artist: item.artist ?? "", album: item.albumTitle,
                                     duration: item.playbackDuration > 0 ? item.playbackDuration : nil)
            }
        }

        var playlists: [ImportedPlaylist] = []
        for collection in MPMediaQuery.playlists().collections ?? [] {
            guard let playlist = collection as? MPMediaPlaylist else { continue }
            let tracks = imported(playlist.items)
            guard !tracks.isEmpty else { continue }
            playlists.append(ImportedPlaylist(name: playlist.name ?? "Playlist Apple Music", source: "Apple Music", tracks: tracks))
        }
        let songs = imported(MPMediaQuery.songs().items ?? [])
        if !songs.isEmpty {
            playlists.insert(ImportedPlaylist(name: "Bibliothèque Apple Music", source: "Apple Music", tracks: songs), at: 0)
        }
        guard !playlists.isEmpty else { throw AppleMusicError.empty }
        return playlists
    }

    enum AppleMusicError: LocalizedError {
        case denied, empty

        var errorDescription: String? {
            switch self {
            case .denied: return "Autorise Nova à accéder à ta bibliothèque dans Réglages › Nova › Musique et vidéo."
            case .empty: return "Aucune playlist ni aucun titre dans la bibliothèque Apple Music de cet iPhone."
            }
        }
    }
}
