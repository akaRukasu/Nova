import SwiftUI
import WebKit

/// Bouton du compte dans la barre de navigation.
struct AccountButton: View {
    @Environment(AccountStore.self) private var account
    @State private var showSheet = false

    var body: some View {
        Button {
            showSheet = true
        } label: {
            if let photo = account.photoURL {
                RemoteImage(urls: [photo])
                    .frame(width: 30, height: 30)
                    .clipShape(Circle())
            } else {
                Image(systemName: account.isSignedIn ? "person.crop.circle.fill" : "person.crop.circle")
            }
        }
        .accessibilityLabel("Compte")
        .sheet(isPresented: $showSheet) {
            AccountSheet()
        }
    }
}

/// Compte YouTube : connexion, déconnexion.
struct AccountSheet: View {
    @Environment(AccountStore.self) private var account
    @Environment(\.dismiss) private var dismiss
    @State private var showSignIn = false
    @State private var confirmSignOut = false

    var body: some View {
        NavigationStack {
            List {
                if account.isSignedIn {
                    Section {
                        HStack(spacing: 14) {
                            if let photo = account.photoURL {
                                RemoteImage(urls: [photo])
                                    .frame(width: 56, height: 56)
                                    .clipShape(Circle())
                            } else {
                                Image(systemName: "person.crop.circle.fill")
                                    .font(.system(size: 52))
                                    .foregroundStyle(.secondary)
                            }
                            VStack(alignment: .leading, spacing: 2) {
                                Text(account.name ?? "Compte YouTube")
                                    .font(.headline)
                                Text("Connecté à YouTube Music")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 4)
                    } footer: {
                        Text("L'accueil est personnalisé, ta bibliothèque YouTube apparaît dans l'onglet Bibliothèque et tes « J'aime » sont envoyés à ton compte.")
                    }
                    Section {
                        Button("Se déconnecter", role: .destructive) { confirmSignOut = true }
                    }
                } else {
                    Section {
                        VStack(alignment: .leading, spacing: 10) {
                            Image(systemName: "person.crop.circle.badge.plus")
                                .font(.system(size: 44))
                                .foregroundStyle(Color.novaAccent)
                            Text("Connecte ton compte YouTube")
                                .font(.title3.weight(.bold))
                            Text("Retrouve tes playlists, tes titres likés, tes albums, tes artistes et un accueil fait pour toi.")
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 8)
                        Button {
                            showSignIn = true
                        } label: {
                            Label("Se connecter avec Google", systemImage: "arrow.right.circle.fill")
                                .font(.headline)
                        }
                    } footer: {
                        Text("La connexion se fait sur la page officielle de Google. Nova garde seulement les cookies de session, dans le trousseau de l'iPhone.")
                    }
                }
            }
            .navigationTitle("Compte")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("OK") { dismiss() }
                }
            }
            .sheet(isPresented: $showSignIn) {
                SignInView()
            }
            .confirmationDialog("Se déconnecter de YouTube ?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Se déconnecter", role: .destructive) {
                    Task { await account.signOut() }
                }
            }
        }
    }
}

/// Page de connexion Google dans l'app.
struct SignInView: View {
    @Environment(AccountStore.self) private var account
    @Environment(\.dismiss) private var dismiss
    @State private var isFinishing = false

    private static let signInURL = URL(string: "https://accounts.google.com/ServiceLogin?ltmpl=music&service=youtube&uilel=3&passive=true&hl=fr&continue=https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue%26app%3Ddesktop%26hl%3Dfr%26next%3Dhttps%253A%252F%252Fmusic.youtube.com%252F")!

    var body: some View {
        NavigationStack {
            SignInWebView(url: Self.signInURL) { webView in
                guard !isFinishing else { return }
                Task {
                    let store = webView.configuration.websiteDataStore.httpCookieStore
                    if await account.completeSignIn(from: store) {
                        isFinishing = true
                        dismiss()
                    }
                }
            }
            .ignoresSafeArea(edges: .bottom)
            .navigationTitle("Connexion")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Annuler") { dismiss() }
                }
            }
        }
    }
}

struct SignInWebView: UIViewRepresentable {
    let url: URL
    /// Appelé à chaque page chargée sur YouTube.
    let onYouTubePage: (WKWebView) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onYouTubePage: onYouTubePage) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        // Agent Safari standard : Google refuse les navigateurs intégrés qu'il ne reconnaît pas.
        webView.customUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1"
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        let onYouTubePage: (WKWebView) -> Void

        init(onYouTubePage: @escaping (WKWebView) -> Void) {
            self.onYouTubePage = onYouTubePage
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard let host = webView.url?.host, host.hasSuffix("youtube.com") else { return }
            onYouTubePage(webView)
        }
    }
}
