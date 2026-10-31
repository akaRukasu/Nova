import Foundation
import Observation
import Security
import WebKit

/// Cookies du compte YouTube connecté, lisibles depuis n'importe quel fil.
final class AuthSession: @unchecked Sendable {
    static let shared = AuthSession()

    private let lock = NSLock()
    private var cookies: [String: String] = [:]
    private static let keychainAccount = "youtube-cookies"

    private init() {
        if let data = Keychain.read(Self.keychainAccount),
           let saved = try? JSONDecoder().decode([String: String].self, from: data) {
            cookies = saved
        }
    }

    var isSignedIn: Bool { sapisid != nil }

    var cookieHeader: String? {
        lock.lock(); defer { lock.unlock() }
        guard !cookies.isEmpty else { return nil }
        return cookies.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: "; ")
    }

    var sapisid: String? {
        lock.lock(); defer { lock.unlock() }
        return cookies["SAPISID"] ?? cookies["__Secure-3PAPISID"]
    }

    func update(_ newCookies: [String: String]) {
        lock.lock()
        cookies = newCookies
        lock.unlock()
        if newCookies.isEmpty {
            Keychain.delete(Self.keychainAccount)
        } else if let data = try? JSONEncoder().encode(newCookies) {
            Keychain.write(data, account: Self.keychainAccount)
        }
    }
}

/// État du compte affiché dans l'interface.
@MainActor
@Observable
final class AccountStore {
    private(set) var isSignedIn = AuthSession.shared.isSignedIn
    private(set) var name: String?
    private(set) var photoURL: URL?
    /// Change à chaque connexion ou déconnexion, pour recharger les pages.
    private(set) var revision = 0

    private let client = InnerTubeClient()

    init() {
        if isSignedIn { Task { await refreshProfile() } }
    }

    /// Récupère les cookies YouTube de la page de connexion. Renvoie `true` si le compte est prêt.
    func completeSignIn(from store: WKHTTPCookieStore) async -> Bool {
        let all = await store.allCookies()
        var jar: [String: String] = [:]
        // Les cookies de youtube.com d'abord, ceux de google.com ne servent pas à l'API.
        for cookie in all where cookie.domain.hasSuffix("youtube.com") {
            jar[cookie.name] = cookie.value
        }
        guard jar["SAPISID"] != nil || jar["__Secure-3PAPISID"] != nil else { return false }
        AuthSession.shared.update(jar)
        isSignedIn = true
        revision += 1
        await refreshProfile()
        return true
    }

    func signOut() async {
        AuthSession.shared.update([:])
        isSignedIn = false
        name = nil
        photoURL = nil
        revision += 1
        let store = WKWebsiteDataStore.default()
        let records = await store.dataRecords(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes())
        await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), for: records)
    }

    func refreshProfile() async {
        guard let info = try? await client.accountInfo() else { return }
        name = info.name.isEmpty ? nil : info.name
        photoURL = info.photo
    }
}

/// Petit accès au trousseau iOS.
enum Keychain {
    private static let service = "com.akarukasu.nova"

    private static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    static func read(_ account: String) -> Data? {
        var request = query(account)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    static func write(_ data: Data, account: String) {
        delete(account)
        var item = query(account)
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(item as CFDictionary, nil)
    }

    static func delete(_ account: String) {
        SecItemDelete(query(account) as CFDictionary)
    }
}
