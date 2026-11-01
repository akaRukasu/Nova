import CoreLocation
import SwiftUI

// MARK: - Concerts

/// Concerts à venir : par artiste, pour tes artistes, et/ou autour d'un lieu.
struct ConcertsView: View {
    @Environment(LibraryStore.self) private var library
    @AppStorage("ticketmasterKey") private var apiKey = ""
    @AppStorage("concertRadius") private var radius = 100
    @AppStorage("concertCity") private var savedCity = ""
    let initialArtist: String?

    @State private var artist = ""
    @State private var city = ""
    @State private var useMyLocation = false
    @State private var concerts: [Concert] = []
    @State private var isLoading = false
    @State private var errorText: String?
    @State private var origin: CLLocation?
    @StateObject private var locator = LocationProvider()

    init(initialArtist: String?) {
        self.initialArtist = initialArtist
    }

    private var myArtists: [String] {
        var counts: [String: Int] = [:]
        for track in library.songs + library.recents {
            let main = track.artist.components(separatedBy: CharacterSet(charactersIn: ",&")).first?
                .trimmingCharacters(in: .whitespaces) ?? track.artist
            if !main.isEmpty { counts[main, default: 0] += 1 }
        }
        let followed = library.saved.filter { $0.kind == .artist }.map(\.title)
        var seen = Set<String>()
        return (followed + counts.sorted { $0.value > $1.value }.map(\.key))
            .filter { seen.insert($0.lowercased()).inserted }
            .prefix(12).map { $0 }
    }

    var body: some View {
        List {
            if apiKey.isEmpty {
                Section {
                    Text("Les concerts viennent de Ticketmaster. Crée une clé gratuite sur developer.ticketmaster.com (rubrique « My Apps »), puis colle la « Consumer Key » ici.")
                        .font(.subheadline)
                    TextField("Clé Ticketmaster", text: $apiKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Link("Créer ma clé", destination: URL(string: "https://developer.ticketmaster.com/products-and-docs/apis/getting-started/")!)
                } header: {
                    Text("Configuration")
                }
            }

            Section {
                TextField("Artiste ou groupe", text: $artist)
                    .submitLabel(.search)
                    .onSubmit { Task { await search() } }
                Toggle("Autour de moi", isOn: $useMyLocation)
                if !useMyLocation {
                    TextField("Ville (facultatif)", text: $city)
                        .submitLabel(.search)
                        .onSubmit { Task { await search() } }
                }
                Picker("Rayon", selection: $radius) {
                    ForEach([25, 50, 100, 250, 500], id: \.self) { Text("\($0) km").tag($0) }
                }
                Button {
                    Task { await search() }
                } label: {
                    Label("Rechercher", systemImage: "magnifyingglass")
                }
                .disabled(apiKey.isEmpty)
            } header: {
                Text("Recherche")
            } footer: {
                Text("Laisse l'artiste vide pour voir tous les concerts autour du lieu choisi.")
            }

            if !myArtists.isEmpty {
                Section("Mes artistes") {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack {
                            ForEach(myArtists, id: \.self) { name in
                                Button(name) {
                                    artist = name
                                    Task { await search() }
                                }
                                .buttonStyle(.bordered)
                            }
                        }
                    }
                    Button("Concerts de tous mes artistes", systemImage: "person.3") {
                        Task { await searchMyArtists() }
                    }
                    .disabled(apiKey.isEmpty)
                }
            }

            ForEach(groupedByMonth, id: \.0) { month, items in
                Section(month) {
                    ForEach(items) { concert in
                        row(concert)
                    }
                }
            }
        }
        .overlay {
            if isLoading {
                ProgressView("Recherche des concerts…")
                    .padding(24)
                    .glassEffect(in: RoundedRectangle(cornerRadius: 20))
            } else if let errorText {
                ContentUnavailableView("Recherche impossible", systemImage: "exclamationmark.triangle",
                                       description: Text(errorText))
            }
        }
        .navigationTitle("Concerts")
        .onAppear {
            if artist.isEmpty, let initialArtist { artist = initialArtist }
            if city.isEmpty { city = savedCity }
            if initialArtist != nil, !apiKey.isEmpty, concerts.isEmpty { Task { await search() } }
        }
    }

    private var groupedByMonth: [(String, [Concert])] {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "fr_FR")
        formatter.dateFormat = "MMMM yyyy"
        var order: [String] = []
        var groups: [String: [Concert]] = [:]
        for concert in concerts {
            let key = formatter.string(from: concert.date).capitalized
            if groups[key] == nil { order.append(key) }
            groups[key, default: []].append(concert)
        }
        return order.map { ($0, groups[$0] ?? []) }
    }

    @ViewBuilder private func row(_ concert: Concert) -> some View {
        let content = HStack(spacing: 12) {
            VStack(spacing: 0) {
                Text(concert.date.formatted(.dateTime.day()))
                    .font(.title2.weight(.bold))
                Text(concert.date.formatted(.dateTime.month(.abbreviated)).uppercased())
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Color.novaAccent)
            }
            .frame(width: 48)
            VStack(alignment: .leading, spacing: 2) {
                Text(concert.name)
                    .font(.body.weight(.medium))
                    .lineLimit(2)
                Text(concert.place)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if let distance = distance(to: concert) {
                    Text("à \(distance) km")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
            Spacer()
            if concert.ticketURL != nil {
                Image(systemName: "ticket")
                    .foregroundStyle(Color.novaAccent)
            }
        }
        if let url = concert.ticketURL {
            Link(destination: url) { content }
                .foregroundStyle(Color.primary)
        } else {
            content
        }
    }

    private func distance(to concert: Concert) -> Int? {
        guard let origin, let lat = concert.latitude, let lon = concert.longitude else { return nil }
        return Int(origin.distance(from: CLLocation(latitude: lat, longitude: lon)) / 1000)
    }

    /// Point de recherche : position actuelle ou ville saisie.
    private func resolveOrigin() async -> CLLocation? {
        if useMyLocation { return await locator.currentLocation() }
        let name = city.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return nil }
        savedCity = name
        return try? await CLGeocoder().geocodeAddressString(name).first?.location
    }

    private func search() async {
        isLoading = true
        errorText = nil
        defer { isLoading = false }
        origin = await resolveOrigin()
        do {
            concerts = try await ConcertsService.search(
                artist: artist.trimmingCharacters(in: .whitespaces),
                latitude: origin?.coordinate.latitude, longitude: origin?.coordinate.longitude,
                radiusKm: radius, countryCode: PlaybackSettings.region)
            if concerts.isEmpty { errorText = "Aucun concert trouvé pour cette recherche." }
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func searchMyArtists() async {
        isLoading = true
        errorText = nil
        defer { isLoading = false }
        origin = await resolveOrigin()
        var all: [Concert] = []
        for name in myArtists {
            let found = (try? await ConcertsService.search(
                artist: name, latitude: origin?.coordinate.latitude, longitude: origin?.coordinate.longitude,
                radiusKm: radius, countryCode: nil)) ?? []
            all += found
            // L'API gratuite limite le nombre de requêtes par seconde.
            try? await Task.sleep(for: .milliseconds(250))
        }
        var seen = Set<String>()
        concerts = all.filter { seen.insert($0.id).inserted }.sorted { $0.date < $1.date }
        if concerts.isEmpty { errorText = "Aucun concert annoncé pour tes artistes dans cette zone." }
    }
}

/// Position actuelle, demandée une seule fois.
@MainActor
final class LocationProvider: NSObject, ObservableObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<CLLocation?, Never>?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyKilometer
    }

    func currentLocation() async -> CLLocation? {
        if manager.authorizationStatus == .notDetermined {
            manager.requestWhenInUseAuthorization()
        }
        return await withCheckedContinuation { continuation in
            self.continuation?.resume(returning: nil)
            self.continuation = continuation
            manager.requestLocation()
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let location = locations.last
        Task { @MainActor in
            self.continuation?.resume(returning: location)
            self.continuation = nil
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            self.continuation?.resume(returning: nil)
            self.continuation = nil
        }
    }
}

// MARK: - Réglages

struct SettingsView: View {
    @Environment(AccountStore.self) private var account
    @AppStorage("audioQualityHigh") private var highQuality = true
    @AppStorage("autoplayRadio") private var autoplayRadio = true
    @AppStorage("recordHistory") private var recordHistory = true
    @AppStorage("cacheOnCellular") private var cacheOnCellular = true
    @AppStorage("downloadOnCellular") private var downloadOnCellular = false
    @AppStorage("cacheLimitMB") private var cacheLimit = 1500
    @AppStorage("contentRegion") private var region = "FR"
    @AppStorage("contentLanguage") private var language = "fr"
    @AppStorage("ticketmasterKey") private var ticketmasterKey = ""
    @AppStorage("releaseWindowDays") private var releaseWindow = 30
    @State private var showAccount = false
    @State private var showImport = false
    @State private var cacheSize: Int64 = 0
    @State private var confirmClear = false

    private let regions = [("FR", "France"), ("BE", "Belgique"), ("CH", "Suisse"), ("CA", "Canada"),
                           ("LU", "Luxembourg"), ("US", "États-Unis"), ("GB", "Royaume-Uni"), ("DE", "Allemagne"),
                           ("ES", "Espagne"), ("IT", "Italie"), ("MA", "Maroc"), ("SN", "Sénégal"), ("CI", "Côte d'Ivoire")]

    var body: some View {
        Form {
            Section("Compte") {
                Button {
                    showAccount = true
                } label: {
                    LabeledContent(account.isSignedIn ? (account.name ?? "Compte YouTube") : "Se connecter à YouTube") {
                        Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                    }
                }
                Button("Importer depuis une autre plateforme") { showImport = true }
            }

            Section {
                Picker("Qualité audio", selection: $highQuality) {
                    Text("Haute").tag(true)
                    Text("Économie de données").tag(false)
                }
                Toggle("Lecture automatique", isOn: $autoplayRadio)
                Toggle("Historique d'écoute", isOn: $recordHistory)
            } header: {
                Text("Lecture")
            } footer: {
                Text("La lecture automatique enchaîne avec des titres similaires à la fin de la file. AirPlay se choisit depuis le lecteur.")
            }

            Section("Données mobiles") {
                Toggle("Mettre en cache les titres écoutés", isOn: $cacheOnCellular)
                Toggle("Télécharger", isOn: $downloadOnCellular)
            }

            Section {
                Picker("Taille maximale du cache", selection: $cacheLimit) {
                    Text("500 Mo").tag(500)
                    Text("1,5 Go").tag(1500)
                    Text("3 Go").tag(3000)
                    Text("5 Go").tag(5000)
                    Text("10 Go").tag(10000)
                }
                LabeledContent("Cache utilisé", value: ByteCountFormatter.string(fromByteCount: cacheSize, countStyle: .file))
                Button("Vider le cache", role: .destructive) { confirmClear = true }
            } header: {
                Text("Stockage")
            }

            Section {
                Picker("Pays du contenu", selection: $region) {
                    ForEach(regions, id: \.0) { Text($0.1).tag($0.0) }
                }
                Picker("Langue", selection: $language) {
                    Text("Français").tag("fr")
                    Text("English").tag("en")
                }
            } header: {
                Text("Contenu")
            } footer: {
                Text("Change l'accueil, les classements et les nouveautés proposés.")
            }

            Section("Sorties") {
                NavigationLink("Mes genres et sorties", value: Route.releases)
                Picker("Période", selection: $releaseWindow) {
                    Text("7 jours").tag(7)
                    Text("30 jours").tag(30)
                    Text("90 jours").tag(90)
                }
            }

            Section {
                TextField("Clé Ticketmaster", text: $ticketmasterKey)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Link("Obtenir une clé gratuite", destination: URL(string: "https://developer.ticketmaster.com/products-and-docs/apis/getting-started/")!)
                NavigationLink("Ouvrir les concerts", value: Route.concerts(artist: nil))
            } header: {
                Text("Concerts")
            } footer: {
                Text("Les concerts sont aussi dans la Bibliothèque, dans Découvrir et sur chaque page artiste (icône billet).")
            }

            Section("À propos") {
                LabeledContent("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "-")
                Text("Nova lit le catalogue YouTube Music. Projet à usage personnel.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Réglages")
        .sheet(isPresented: $showAccount) { AccountSheet() }
        .sheet(isPresented: $showImport) { ImportView() }
        .task { cacheSize = await AudioCache.shared.sizeInBytes() }
        .confirmationDialog("Vider le cache ?", isPresented: $confirmClear, titleVisibility: .visible) {
            Button("Vider", role: .destructive) {
                Task {
                    await AudioCache.shared.clear()
                    await PageCache.shared.clear()
                    cacheSize = await AudioCache.shared.sizeInBytes()
                }
            }
        }
    }
}
