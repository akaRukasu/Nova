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
        var duration: Double
        var playing: Bool
        var audible: Bool
        var ended: Bool
        var blocked: String?
        var upcoming: [Upcoming]?
        var mixing: Bool?
        var fading: Bool?

        func matches(_ track: Track) -> Bool {
            if let id, let expected = OctaveCatalog.id(track.id) {
                guard id == expected else { return false }
                if title.isEmpty { return true }
            }
            return OctaveCatalog.sameRecording(track, Track(id: "sample", title: title, artist: artist, duration: duration))
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

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.allowsAirPlayForMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        if let url = Bundle.main.url(forResource: "nova-octave", withExtension: "js"),
           let script = try? String(contentsOf: url, encoding: .utf8) {
            configuration.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
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
        panel = false
        view.removeFromSuperview()
        attach()
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

    func sample() async -> Sample? {
        guard let raw = await call("sample"), JSONSerialization.isValidJSONObject(raw),
              let data = try? JSONSerialization.data(withJSONObject: raw) else { return nil }
        return try? JSONDecoder().decode(Sample.self, from: data)
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

    private func navigate(_ url: URL) async throws {
        if view.url != url || view.isLoading {
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
        for url in [OctaveCatalog.trackURL(track), OctaveCatalog.searchURL(track)].compactMap({ $0 }) {
            try Task.checkCancellation()
            guard generation == request else { throw CancellationError() }
            try await navigate(url)
            var sentAt: Date?
            var retried = false
            for _ in 0..<45 {
                try Task.checkCancellation()
                guard generation == request else { throw CancellationError() }
                let state = await sample()
                if state?.blocked == "sign-in" { throw Failure.connection }
                if state?.blocked == "interaction" { throw Failure.interaction }
                if let state, state.matches(track), state.playing, let elapsed = state.position {
                    if position > 0 || elapsed > 2 { await command("seek", value: position) }
                    return state
                }
                if sentAt == nil || (!retried && state?.matches(track) != true && Date().timeIntervalSince(sentAt!) > 1.8) {
                    if await call("select", args: ["id": id, "retry": sentAt != nil]) as? Bool == true {
                        retried = sentAt != nil
                        sentAt = Date()
                    }
                }
                try await Task.sleep(for: .milliseconds(180))
            }
        }
        throw Failure.unavailable
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
