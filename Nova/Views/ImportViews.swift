import SwiftUI
import UniformTypeIdentifiers
import WebKit

/// Point d'entrée de l'import : comptes, lien, fichier.
struct ImportView: View {
    @Environment(ImportManager.self) private var importer
    @Environment(\.dismiss) private var dismiss
    @State private var link = ""
    @State private var isLoading = false
    @State private var errorText: String?
    @State private var found: [ImportedPlaylist] = []
    @State private var showSelection = false
    @State private var showFilePicker = false
    @State private var loginService: StreamingService?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    serviceButton(.spotify)
                    serviceButton(.deezer)
                    Button {
                        load { try await ImportManager.appleMusicLibrary() }
                    } label: {
                        serviceLabel("Apple Music", detail: "Playlists de la bibliothèque de l'iPhone",
                                     icon: "applelogo", color: .pink)
                    }
                    .buttonStyle(.plain)
                } header: {
                    Text("Depuis un compte")
                } footer: {
                    Text("Nova lit tes playlists et tes titres likés, puis retrouve chaque titre sur YouTube Music.")
                }

                Section {
                    TextField("Lien Spotify, Deezer, Apple Music, YouTube…", text: $link)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .onSubmit(importLink)
                    Button("Importer ce lien", systemImage: "link", action: importLink)
                        .disabled(link.trimmingCharacters(in: .whitespaces).isEmpty)
                    if UIPasteboard.general.hasURLs || UIPasteboard.general.hasStrings {
                        Button("Coller", systemImage: "doc.on.clipboard") {
                            link = UIPasteboard.general.url?.absoluteString ?? UIPasteboard.general.string ?? ""
                        }
                    }
                } header: {
                    Text("Depuis un lien")
                } footer: {
                    Text("Playlist ou album public. Un lien de profil Deezer importe toutes ses playlists publiques et ses coups de cœur.")
                }

                Section {
                    Button("Choisir un fichier CSV, TXT ou JSON", systemImage: "doc.badge.plus") {
                        showFilePicker = true
                    }
                } header: {
                    Text("Depuis un fichier")
                } footer: {
                    Text("Pour Tidal, Amazon Music, SoundCloud, Qobuz ou toute autre plateforme : exporte tes playlists en CSV avec TuneMyMusic ou Soundiiz, puis choisis le fichier ici. L'export de données Spotify (YourLibrary.json, Playlist1.json) et les listes « Artiste - Titre » fonctionnent aussi.")
                }

                if !importer.jobs.isEmpty {
                    ImportJobsSection()
                }
            }
            .navigationTitle("Importer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("OK") { dismiss() }
                }
            }
            .overlay {
                if isLoading {
                    ProgressView("Lecture des playlists…")
                        .padding(24)
                        .glassEffect(in: RoundedRectangle(cornerRadius: 20))
                }
            }
            .alert("Import impossible", isPresented: Binding(get: { errorText != nil }, set: { if !$0 { errorText = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(errorText ?? "")
            }
            .navigationDestination(isPresented: $showSelection) {
                ImportSelectionView(playlists: found) { dismiss() }
            }
            .fileImporter(isPresented: $showFilePicker,
                          allowedContentTypes: [.commaSeparatedText, .plainText, .json, .text, .data],
                          allowsMultipleSelection: true) { result in
                importFiles(result)
            }
            .sheet(item: $loginService) { service in
                ServiceLoginView(service: service) { playlists in
                    found = playlists
                    showSelection = true
                }
            }
        }
    }

    private func serviceButton(_ service: StreamingService) -> some View {
        Button {
            loginService = service
        } label: {
            serviceLabel(service.name, detail: "Se connecter et choisir les playlists", icon: service.icon, color: service.color)
        }
        .buttonStyle(.plain)
    }

    private func serviceLabel(_ name: String, detail: String, icon: String, color: Color) -> some View {
        HStack(spacing: 14) {
            Image(systemName: icon)
                .font(.title3.weight(.semibold))
                .foregroundStyle(.white)
                .frame(width: 40, height: 40)
                .background(color.gradient, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(.body.weight(.semibold))
                Text(detail).font(.subheadline).foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
    }

    private func importLink() {
        let text = link
        load { try await ImportSources.fromLink(text) }
    }

    private func load(_ work: @escaping () async throws -> [ImportedPlaylist]) {
        isLoading = true
        Task {
            defer { isLoading = false }
            do {
                let playlists = try await work()
                guard !playlists.isEmpty else { throw ImportError.nothingFound }
                found = playlists
                showSelection = true
            } catch {
                errorText = error.localizedDescription
            }
        }
    }

    private func importFiles(_ result: Result<[URL], Error>) {
        switch result {
        case .failure(let error):
            errorText = error.localizedDescription
        case .success(let urls):
            var playlists: [ImportedPlaylist] = []
            var failures: [String] = []
            for url in urls {
                let access = url.startAccessingSecurityScopedResource()
                defer { if access { url.stopAccessingSecurityScopedResource() } }
                do {
                    let data = try Data(contentsOf: url)
                    playlists += try ImportSources.fromFile(data, fileName: url.lastPathComponent)
                } catch {
                    failures.append(url.lastPathComponent)
                }
            }
            if playlists.isEmpty {
                errorText = "Aucun titre reconnu dans \(failures.joined(separator: ", ")). Le fichier doit contenir au moins une colonne titre et une colonne artiste."
            } else {
                found = playlists
                showSelection = true
            }
        }
    }
}

/// Choix des playlists à importer.
struct ImportSelectionView: View {
    @Environment(ImportManager.self) private var importer
    @Environment(LibraryStore.self) private var library
    let playlists: [ImportedPlaylist]
    let onStart: () -> Void
    @State private var selected: Set<UUID> = []

    var body: some View {
        List {
            Section {
                ForEach(playlists) { playlist in
                    Button {
                        if selected.contains(playlist.id) { selected.remove(playlist.id) } else { selected.insert(playlist.id) }
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: selected.contains(playlist.id) ? "checkmark.circle.fill" : "circle")
                                .font(.title3)
                                .foregroundStyle(selected.contains(playlist.id) ? Color.novaAccent : .secondary)
                            Image(systemName: playlist.isLiked ? "heart.fill" : "music.note.list")
                                .foregroundStyle(playlist.isLiked ? .pink : .secondary)
                                .frame(width: 24)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(playlist.name)
                                    .foregroundStyle(Color.primary)
                                    .lineLimit(1)
                                Text(playlist.count > 0 ? "\(playlist.count) titres" : "Titres chargés à l'import")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            } header: {
                HStack {
                    Text("\(playlists.count) liste\(playlists.count > 1 ? "s" : "") trouvée\(playlists.count > 1 ? "s" : "")")
                    Spacer()
                    Button(selected.count == playlists.count ? "Tout désélectionner" : "Tout sélectionner") {
                        selected = selected.count == playlists.count ? [] : Set(playlists.map(\.id))
                    }
                    .font(.footnote.weight(.semibold))
                    .textCase(nil)
                }
            } footer: {
                Text("Les titres likés vont dans « Titres likés », les autres listes deviennent des playlists Nova. L'import continue même si tu fermes cet écran.")
            }
        }
        .navigationTitle("Choisir")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            Button {
                importer.start(playlists.filter { selected.contains($0.id) }, into: library)
                onStart()
            } label: {
                Text(selected.count <= 1 ? "Importer" : "Importer \(selected.count) listes")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.glassProminent)
            .controlSize(.large)
            .disabled(selected.isEmpty)
            .padding()
        }
        .onAppear { if selected.isEmpty { selected = Set(playlists.map(\.id)) } }
    }
}

/// Avancement des imports (écran d'import et bibliothèque).
struct ImportJobsSection: View {
    @Environment(ImportManager.self) private var importer

    var body: some View {
        Section {
            ForEach(importer.jobs) { job in
                NavigationLink {
                    MissingTracksView(job: job)
                } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(job.name)
                                .font(.body.weight(.medium))
                                .lineLimit(1)
                            Spacer()
                            Text(job.source)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        if let error = job.error {
                            Text(error)
                                .font(.caption)
                                .foregroundStyle(.red)
                        } else if job.isFinished {
                            Text(job.missing.isEmpty
                                 ? "\(job.matched) titres importés"
                                 : "\(job.matched) titres importés, \(job.missing.count) introuvables")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        } else {
                            ProgressView(value: job.progress)
                            Text(job.total > 0 ? "\(job.processed) / \(job.total) — \(job.matched) trouvés" : "Chargement des titres…")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 2)
                }
                .disabled(job.missing.isEmpty)
            }
        } header: {
            HStack {
                Text("Imports")
                Spacer()
                if importer.jobs.contains(where: \.isFinished) {
                    Button("Effacer") { importer.clearFinished() }
                        .font(.footnote.weight(.semibold))
                        .textCase(nil)
                }
            }
        }
    }
}

struct MissingTracksView: View {
    let job: ImportManager.Job

    var body: some View {
        List {
            Section {
                ForEach(Array(job.missing.enumerated()), id: \.offset) { _, track in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(track.title)
                        Text(track.artist)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
            } footer: {
                Text("Ces titres n'ont pas été trouvés sur YouTube Music. Tu peux les chercher à la main dans l'onglet Recherche.")
            }
        }
        .navigationTitle("Introuvables")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Connexion aux plateformes

enum StreamingService: String, Identifiable {
    case spotify, deezer

    var id: String { rawValue }

    var name: String {
        switch self {
        case .spotify: return "Spotify"
        case .deezer: return "Deezer"
        }
    }

    var icon: String {
        switch self {
        case .spotify: return "dot.radiowaves.left.and.right"
        case .deezer: return "waveform"
        }
    }

    var color: Color {
        switch self {
        case .spotify: return Color(red: 0.11, green: 0.73, blue: 0.33)
        case .deezer: return Color(red: 0.64, green: 0.22, blue: 0.93)
        }
    }

    var loginURL: URL {
        switch self {
        case .spotify: return URL(string: "https://accounts.spotify.com/fr/login?continue=https%3A%2F%2Fopen.spotify.com%2F")!
        case .deezer: return URL(string: "https://www.deezer.com/fr/login")!
        }
    }
}

/// Connexion à Spotify ou Deezer dans l'app, puis lecture des playlists du compte.
struct ServiceLoginView: View {
    @Environment(ImportManager.self) private var importer
    @Environment(\.dismiss) private var dismiss
    let service: StreamingService
    let onLoaded: ([ImportedPlaylist]) -> Void
    @State private var isLoading = false
    @State private var errorText: String?
    @State private var done = false

    var body: some View {
        NavigationStack {
            ServiceWebView(service: service) { credential in
                guard !done, !isLoading else { return }
                Task { await finish(with: credential) }
            }
            .ignoresSafeArea(edges: .bottom)
            .overlay {
                if isLoading {
                    ProgressView("Lecture de ta bibliothèque…")
                        .padding(24)
                        .glassEffect(in: RoundedRectangle(cornerRadius: 20))
                }
            }
            .navigationTitle(service.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Annuler") { dismiss() }
                }
            }
            .alert("Import impossible", isPresented: Binding(get: { errorText != nil }, set: { if !$0 { errorText = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(errorText ?? "")
            }
        }
    }

    private func finish(with credential: String) async {
        isLoading = true
        defer { isLoading = false }
        do {
            let playlists: [ImportedPlaylist]
            switch service {
            case .spotify:
                importer.spotifyToken = credential
                playlists = try await ImportSources.spotifyAccount(token: credential)
            case .deezer:
                playlists = try await ImportSources.deezerProfile(userID: credential)
            }
            guard !playlists.isEmpty else { throw ImportError.nothingFound }
            done = true
            dismiss()
            onLoaded(playlists)
        } catch {
            // Un jeton anonyme (avant connexion) est refusé : on attend le suivant sans alerte.
            if case ImportError.http(401, _)? = error as? ImportError, service == .spotify { return }
            errorText = error.localizedDescription
        }
    }
}

/// Page de connexion qui récupère l'accès au compte une fois connecté.
/// Spotify : jeton envoyé par le lecteur web. Deezer : identifiant du compte.
struct ServiceWebView: UIViewRepresentable {
    let service: StreamingService
    let onCredential: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(service: service, onCredential: onCredential) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        if service == .spotify {
            configuration.userContentController.add(context.coordinator, name: "novaToken")
            configuration.userContentController.addUserScript(
                WKUserScript(source: Self.tokenSpy, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        }
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15"
        webView.navigationDelegate = context.coordinator
        webView.load(URLRequest(url: service.loginURL))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    /// Repère le jeton « Bearer » que le lecteur web de Spotify envoie à son API.
    private static let tokenSpy = """
    (function () {
      if (window.__novaSpy) return; window.__novaSpy = true;
      var send = function (value) {
        try { if (value && value.indexOf('Bearer ') === 0) window.webkit.messageHandlers.novaToken.postMessage(value.slice(7)); } catch (e) {}
      };
      var originalFetch = window.fetch;
      window.fetch = function (input, init) {
        try {
          var headers = (init && init.headers) || (input && input.headers);
          if (headers) {
            if (typeof headers.get === 'function') send(headers.get('authorization'));
            else send(headers.authorization || headers.Authorization);
          }
        } catch (e) {}
        return originalFetch.apply(this, arguments);
      };
      var originalSet = XMLHttpRequest.prototype.setRequestHeader;
      XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        try { if (String(name).toLowerCase() === 'authorization') send(value); } catch (e) {}
        return originalSet.apply(this, arguments);
      };
    })();
    """

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        let service: StreamingService
        let onCredential: (String) -> Void
        private var delivered = false
        private var lastToken: String?

        init(service: StreamingService, onCredential: @escaping (String) -> Void) {
            self.service = service
            self.onCredential = onCredential
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            // Le lecteur envoie un jeton anonyme avant la connexion : on ne garde que ceux
            // reçus sur open.spotify.com, et chaque nouveau jeton est retenté.
            guard service == .spotify, let token = message.body as? String, token.count > 40, token != lastToken,
                  message.webView?.url?.host?.contains("open.spotify.com") == true else { return }
            lastToken = token
            onCredential(token)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard service == .deezer, !delivered,
                  let url = webView.url, url.host?.hasSuffix("deezer.com") == true,
                  !url.path.contains("login") else { return }
            let script = """
            const response = await fetch('/ajax/gw-light.php?method=deezer.getUserData&input=3&api_version=1.0&api_token=', { credentials: 'include' });
            const json = await response.json();
            return String(json.results.USER.USER_ID);
            """
            webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { [weak self] result in
                guard let self, !self.delivered, case .success(let value) = result,
                      let userID = value as? String, userID != "0", !userID.isEmpty else { return }
                self.delivered = true
                self.onCredential(userID)
            }
        }
    }
}
