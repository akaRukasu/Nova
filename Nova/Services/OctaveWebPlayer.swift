import SwiftUI
import WebKit

@MainActor
final class OctaveWebPlayer: NSObject, WKNavigationDelegate, WKUIDelegate {
    enum Failure: LocalizedError, Equatable {
        case notFound, unavailable, connection, interaction
        var errorDescription: String? {
            switch self {
            case .notFound: "Version introuvable sur Octave. Tu peux changer la source dans le lecteur."
            case .unavailable: "Ce titre ne démarre pas sur Octave."
            case .connection: "Connecte Octave, puis relance le titre."
            case .interaction: "Ferme la fenêtre dans Octave, puis relance la lecture."
            }
        }
    }
    struct Sample: Decodable {
        struct Upcoming: Decodable {
            var id: String
            var title: String
            var artist: String
            var artwork: URL?
            var track: Track { Track(id: id, title: title, artist: artist, artworkURL: artwork) }
        }
        var id: String?
        var title: String
        var artist: String
        var album: String
        var artwork: URL?
        var position: Double?
        var outgoingPosition: Double?
        var audioId: Int?
        var buffering: Bool?
        var duration: Double
        var playing: Bool
        var audible: Bool
        var ended: Bool
        var blocked: String?
        var upcoming: [Upcoming]?
        var mixing: Bool?
        var fading: Bool?

        func matches(_ track: Track) -> Bool {
            if let id, id == OctaveCatalog.id(track.id) { return true }
            if title.isEmpty { return id != nil && id == OctaveCatalog.id(track.id) }
            return OctaveCatalog.sameRecording(track, Track(id: "sample", title: title, artist: artist, duration: duration))
        }

        func switchedAudio(previousID: Int?, position previousPosition: Double, duration previousDuration: Double) -> Bool {
            if let previousID, let audioId, previousID != audioId { return true }
            if let position, previousPosition > 4, position + 3 < previousPosition { return true }
            return (previousID == nil || audioId == nil) && previousDuration > 0 && duration > 0 && abs(previousDuration - duration) > 1.5
        }
        var track: Track? {
            guard !title.isEmpty else { return nil }
            let key = id.flatMap(OctaveCatalog.key) ?? "octave:played-" + [title, artist, album].joined(separator: "|")
            return Track(id: key, title: title, artist: artist, album: album, duration: duration, artworkURL: artwork)
        }
    }

    let view: WKWebView
    private var generation = 0
    private var prepared: [String: Any]?
    private var preparing: Task<Void, Error>?
    private(set) var panel = false
    private var dismissDialog: (() -> Void)?

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.allowsAirPlayForMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        for resource in ["nova-octave-library", "nova-octave-transition", "nova-octave"] {
            if let url = Bundle.main.url(forResource: resource, withExtension: "js"),
               let script = try? String(contentsOf: url, encoding: .utf8) {
                configuration.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
            }
        }
        view = WKWebView(frame: CGRect(x: 0, y: 0, width: 1280, height: 780), configuration: configuration)
        super.init()
        view.navigationDelegate = self
        view.uiDelegate = self
        view.accessibilityElementsHidden = true
        view.isUserInteractionEnabled = false
    }

    func attach() {
        guard !panel, view.superview == nil,
              let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
                .flatMap(\.windows).first(where: \.isKeyWindow) else { return }
        view.frame = CGRect(x: 0, y: 0, width: 1280, height: 780)
        view.isUserInteractionEnabled = false
        view.accessibilityElementsHidden = true
        window.insertSubview(view, at: 0)
    }

    func showAccount(loadSettings: Bool) {
        panel = true
        view.removeFromSuperview()
        view.isUserInteractionEnabled = true
        view.accessibilityElementsHidden = false
        if loadSettings { view.load(URLRequest(url: OctaveCatalog.origin.appending(path: "settings"))) }
    }

    func hideAccount() {
        dismissDialog?()
        panel = false
        view.removeFromSuperview()
        attach()
        refreshSettings()
    }

    func warmUp() {
        attach()
        Task { try? await prepare() }
    }

    func refreshSettings() {
        guard !panel else { return }
        prepared = nil
        Task { _ = await call("settingsLive", args: PlaybackSettings.octaveAudio) }
    }

    private func call(_ operation: String, args: [String: Any] = [:]) async -> Any? {
        guard view.url?.host == OctaveCatalog.origin.host else { return nil }
        return try? await view.callAsyncJavaScript(
            "return JSON.parse(JSON.stringify(window.novaOctave?.(operation, args) ?? null))",
            arguments: ["operation": operation, "args": args], in: nil, contentWorld: .page)
    }

    func sample(track: Track? = nil, next: Track? = nil) async -> Sample? {
        let trackID = !panel && (PlaybackSettings.octaveAudio["transition"] as? String) == "automix"
            ? track.flatMap { OctaveCatalog.id($0.id) } : nil
        let args = trackID.map { ["track": $0, "pair": next?.id ?? ""] } ?? [:]
        guard let raw = await call("sample", args: args), JSONSerialization.isValidJSONObject(raw),
              let data = try? JSONSerialization.data(withJSONObject: raw) else { return nil }
        return try? JSONDecoder().decode(Sample.self, from: data)
    }

    func libraryCall(_ args: [String: Any]) async -> Any? {
        await call("library", args: args)
    }

    @discardableResult func command(_ type: String, value: Double? = nil) async -> Bool {
        var args: [String: Any] = ["type": type]
        if let value { args["value"] = value }
        return await call("command", args: args) as? Bool == true
    }

    func invalidate() {
        generation += 1
        preparing?.cancel()
        preparing = nil
        view.stopLoading()
    }

    func stop() async {
        invalidate()
        await view.pauseAllMediaPlayback()
    }

    private func navigate(_ url: URL, force: Bool = false) async throws {
        if force || view.url != url || view.isLoading {
            if !force, !view.isLoading, await call("navigate", args: ["url": url.absoluteString]) as? Bool == true { return }
            view.load(URLRequest(url: url))
            for _ in 0..<72 {
                try Task.checkCancellation()
                if view.url == url && !view.isLoading { return }
                try await Task.sleep(for: .milliseconds(160))
            }
            throw Failure.unavailable
        }
    }

    private func prepare() async throws {
        let settings = PlaybackSettings.octaveAudio
        if let prepared, NSDictionary(dictionary: prepared).isEqual(to: settings) { return }
        if let preparing { return try await preparing.value }
        let task = Task {
            try await navigate(OctaveCatalog.origin.appending(path: "settings"))
            for _ in 0..<25 {
                try Task.checkCancellation()
                let result = await call("settings", args: settings)
                if result as? String == "sign-in" { throw Failure.connection }
                if result as? String == "interaction" { throw Failure.interaction }
                if result as? Bool == true { prepared = settings; return }
                try await Task.sleep(for: .milliseconds(180))
            }
        }
        preparing = task
        defer { if !task.isCancelled { preparing = nil } }
        try await task.value
    }

    func start(_ track: Track, position: Double) async throws -> Sample {
        generation += 1
        let request = generation
        attach()
        guard let id = OctaveCatalog.id(track.id) else { throw Failure.notFound }
        await view.pauseAllMediaPlayback()
        try await prepare()
        let locations = [OctaveCatalog.trackURL(track), OctaveCatalog.trackURL(track), OctaveCatalog.searchURL(track)].compactMap { $0 }
        for (attempt, url) in locations.enumerated() {
            try Task.checkCancellation()
            guard generation == request else { throw CancellationError() }
            try await navigate(url, force: attempt == 1)
            var sentAt: Date?
            var selections = 0
            var resumedAt = Date.distantPast
            for _ in 0..<65 {
                try Task.checkCancellation()
                guard generation == request else { throw CancellationError() }
                let state = await sample()
                if state?.blocked == "sign-in" { throw Failure.connection }
                if state?.blocked == "interaction" { throw Failure.interaction }
                let sameTrack = state?.matches(track) == true
                if let state, sameTrack, state.playing, let elapsed = state.position, elapsed > 0.05 {
                    if position > 0 || elapsed > 2 { await command("seek", value: position) }
                    return state
                }
                let sinceSelection = sentAt.map { Date().timeIntervalSince($0) } ?? 0
                if sameTrack, state?.playing == false, sinceSelection >= 0.9, Date().timeIntervalSince(resumedAt) > 1.5 {
                    if await command("play") { resumedAt = Date() }
                }
                if sentAt == nil || (selections < 3 && !sameTrack && sinceSelection > 2.4) {
                    if await call("select", args: ["id": id, "retry": sentAt != nil]) as? Bool == true {
                        selections += 1
                        sentAt = Date()
                    }
                }
                try await Task.sleep(for: .milliseconds(180))
            }
        }
        throw Failure.unavailable
    }

    func clearQueue() async {
        let request = generation
        for _ in 0..<10 {
            guard generation == request, !Task.isCancelled, !panel else { return }
            if await call("clearQueue") as? Bool == true { return }
            try? await Task.sleep(for: .milliseconds(100))
        }
    }

    func enqueue(_ track: Track) async -> Bool {
        let request = generation
        guard let id = OctaveCatalog.id(track.id) else { return false }
        let queries = [track.title + " " + track.artist, "\"" + track.title + "\" " + track.artist, track.artist + " " + track.title]
        var searched = false
        for attempt in 0..<queries.count * 8 {
            if attempt % 8 == 0 { searched = false }
            guard generation == request, !Task.isCancelled, !panel else { return false }
            if await call("queue", args: ["id": id]) as? Bool == true { return generation == request }
            if !searched {
                searched = await call("search", args: ["query": queries[attempt / 8]]) as? Bool == true
            }
            try? await Task.sleep(for: .milliseconds(250))
        }
        return false
    }

    private func allows(_ url: URL?) -> Bool {
        guard let url, url.scheme == "https", url.user == nil, url.password == nil, url.port == nil || url.port == 443 else { return false }
        return url.host == OctaveCatalog.origin.host
            || (panel && ["discord.com", "api.octavestreaming.com"].contains(url.host ?? ""))
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard navigationAction.targetFrame?.isMainFrame != false else { return .allow }
        return allows(navigationAction.request.url) ? .allow : .cancel
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if allows(navigationAction.request.url) { webView.load(navigationAction.request) }
        return nil
    }

    private func presentDialog(_ alert: UIAlertController, cancel: @escaping () -> Void) {
        dismissDialog?()
        guard panel, allows(view.url), var presenter = view.window?.rootViewController else {
            cancel()
            return
        }
        while let presented = presenter.presentedViewController { presenter = presented }
        if presenter.isBeingDismissed {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                guard let self else { cancel(); return }
                self.presentDialog(alert, cancel: cancel)
            }
            return
        }
        dismissDialog = { [weak alert] in
            alert?.dismiss(animated: false)
            cancel()
        }
        presenter.present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        var completed = false
        let finish: (Bool) -> Void = { [weak self] accepted in
            guard !completed else { return }
            completed = true
            self?.dismissDialog = nil
            completionHandler(accepted)
        }
        let alert = UIAlertController(title: "Octave", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Annuler", style: .cancel) { _ in finish(false) })
        alert.addAction(UIAlertAction(title: "Continuer", style: .default) { _ in finish(true) })
        presentDialog(alert, cancel: { finish(false) })
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        var completed = false
        let finish: () -> Void = { [weak self] in
            guard !completed else { return }
            completed = true
            self?.dismissDialog = nil
            completionHandler()
        }
        let alert = UIAlertController(title: "Octave", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in finish() })
        presentDialog(alert, cancel: finish)
    }
}

struct OctaveAccountView: UIViewRepresentable {
    let player: OctaveWebPlayer
    func makeUIView(context: Context) -> WKWebView { player.view }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

struct OctaveAccountSheet: View {
    @Environment(PlayerModel.self) private var player
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            OctaveAccountView(player: player.octave)
                .navigationTitle("Compte Octave")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Retour à Nova") { dismiss() }
                    }
                }
        }
    }
}
