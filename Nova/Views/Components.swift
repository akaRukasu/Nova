import AVKit
import SwiftUI

/// Vignette carrée arrondie (ronde pour un artiste).
struct ArtworkThumb: View {
    let urls: [URL]
    var size: CGFloat = 52
    var corner: CGFloat = 8
    var circle = false

    init(track: Track?, size: CGFloat = 52, corner: CGFloat = 8) {
        self.urls = track?.artworkURLs(pixels: Int(size * 3)) ?? []
        self.size = size
        self.corner = corner
    }

    init(urls: [URL], size: CGFloat = 52, corner: CGFloat = 8, circle: Bool = false) {
        self.urls = urls.map { $0.resizedArtwork(pixels: Int(size * 3)) }
        self.size = size
        self.corner = corner
        self.circle = circle
    }

    var body: some View {
        RemoteImage(urls: urls)
            .frame(width: size, height: size)
            .clipShape(circle ? AnyShape(Circle())
                       : AnyShape(RoundedRectangle(cornerRadius: max(corner, size * 0.15), style: .continuous)))
    }
}

/// Contenu d'une ligne de titre.
struct TrackRow: View {
    @Environment(LibraryStore.self) private var library
    @Environment(DownloadStore.self) private var downloads
    let track: Track
    var isCurrent = false
    /// Numéro de piste (albums) à la place de la pochette.
    var number: Int?

    var body: some View {
        HStack(spacing: 12) {
            if let number {
                Text("\(number)")
                    .font(.body.monospacedDigit())
                    .foregroundStyle(isCurrent ? Color.novaAccent : .secondary)
                    .frame(width: 28)
            } else {
                ArtworkThumb(track: track)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(track.title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(isCurrent ? Color.novaAccent : Color.primary)
                    .lineLimit(1)
                HStack(spacing: 4) {
                    if downloads.state(of: track.id) == .downloaded {
                        Image(systemName: "arrow.down.circle.fill")
                            .font(.caption2)
                            .foregroundStyle(Color.novaAccent)
                    }
                    if library.isLiked(track.id) {
                        Image(systemName: "heart.fill")
                            .font(.caption2)
                            .foregroundStyle(.pink)
                    }
                    Text(number == nil ? track.subtitle : track.artist)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            if let duration = track.duration {
                Text(duration.clockString)
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
        .contentShape(Rectangle())
    }
}

/// Ligne de titre complète : appui pour lire, bouton « … » et menu contextuel.
struct TrackRowButton: View {
    @Environment(PlayerModel.self) private var player
    @Environment(LibraryStore.self) private var library
    let track: Track
    var number: Int?
    var onRemove: (() -> Void)?
    /// Bouton « + » pour ajouter le titre à la bibliothèque (résultats de recherche).
    var showsAddButton = false
    let action: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            Button(action: action) {
                TrackRow(track: track, isCurrent: player.current?.id == track.id, number: number)
            }
            .buttonStyle(.plain)

            if showsAddButton {
                AddToLibraryButton(isAdded: library.isInLibrary(track.id)) {
                    if library.isInLibrary(track.id) { library.removeFromLibrary(track) } else { library.addToLibrary(track) }
                }
            }

            Menu {
                TrackMenu(track: track, onRemove: onRemove)
            } label: {
                Image(systemName: "ellipsis")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 32, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .contextMenu { TrackMenu(track: track, onRemove: onRemove) }
    }
}

/// Ligne d'album, de playlist ou d'artiste.
struct CollectionRow: View {
    let collection: MusicCollection

    var body: some View {
        HStack(spacing: 12) {
            ArtworkThumb(urls: collection.artworkURLs, circle: collection.kind == .artist)
            VStack(alignment: .leading, spacing: 2) {
                Text(collection.title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                Text(collection.subtitle.isEmpty ? collection.kind.label : collection.subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
    }
}

/// Élément d'une liste : titre jouable ou lien vers une page.
struct ItemRow: View {
    @Environment(LibraryStore.self) private var library
    let item: MusicItem
    var showsAddButton = false
    let onPlay: (Track) -> Void

    var body: some View {
        switch item {
        case .track(let track):
            TrackRowButton(track: track, showsAddButton: showsAddButton) { onPlay(track) }
        case .collection(let collection):
            HStack(spacing: 4) {
                NavigationLink(value: Route.collection(collection)) {
                    CollectionRow(collection: collection)
                }
                .buttonStyle(.plain)
                if showsAddButton {
                    AddToLibraryButton(isAdded: library.isSaved(collection.id)) {
                        library.toggleSaved(collection)
                    }
                }
            }
            .contextMenu { CollectionMenu(collection: collection) }
        case .category(let category):
            NavigationLink(value: Route.more(title: category.title, link: category.link)) {
                CategoryTile(category: category)
                    .frame(height: 64)
            }
            .buttonStyle(.plain)
        }
    }
}

/// « + » / « ✓ » : ajouter à la bibliothèque ou retirer.
struct AddToLibraryButton: View {
    let isAdded: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: isAdded ? "checkmark.circle.fill" : "plus.circle")
                .font(.title3)
                .foregroundStyle(Color.novaAccent)
                .contentTransition(.symbolEffect(.replace))
                .frame(width: 36, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .sensoryFeedback(.success, trigger: isAdded)
        .accessibilityLabel(isAdded ? "Retirer de la bibliothèque" : "Ajouter à la bibliothèque")
    }
}

/// Tuile colorée d'une catégorie (« Parcourir »).
struct CategoryTile: View {
    let category: BrowseCategory

    private var color: Color {
        let value = category.color
        return Color(red: Double((value >> 16) & 0xFF) / 255,
                     green: Double((value >> 8) & 0xFF) / 255,
                     blue: Double(value & 0xFF) / 255)
    }

    /// Icône évocatrice, d'après le nom de la catégorie.
    private var icon: String {
        let name = category.title.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil).lowercased()
        let table: [(String, String)] = [
            ("energie", "bolt.fill"), ("entrain", "figure.run"), ("sport", "figure.run"), ("workout", "figure.run"),
            ("humeur", "sun.max.fill"), ("bonheur", "sun.max.fill"), ("feel", "sun.max.fill"),
            ("concentration", "brain.head.profile"), ("focus", "brain.head.profile"), ("etude", "book.fill"),
            ("calme", "leaf.fill"), ("detente", "leaf.fill"), ("chill", "leaf.fill"), ("relax", "leaf.fill"),
            ("sommeil", "moon.zzz.fill"), ("dormir", "moon.zzz.fill"), ("sleep", "moon.zzz.fill"),
            ("soiree", "party.popper.fill"), ("fete", "party.popper.fill"), ("party", "party.popper.fill"),
            ("romance", "heart.fill"), ("amour", "heart.fill"), ("love", "heart.fill"),
            ("triste", "cloud.rain.fill"), ("melancol", "cloud.rain.fill"), ("automne", "leaf.fill"),
            ("ete", "sun.horizon.fill"), ("hiver", "snowflake"), ("noel", "gift.fill"), ("halloween", "moon.stars.fill"),
            ("voyage", "car.fill"), ("route", "car.fill"), ("trajet", "tram.fill"), ("cuisine", "fork.knife"),
            ("annees", "clock.arrow.circlepath"), ("decennie", "clock.arrow.circlepath"), ("70", "clock.arrow.circlepath"),
            ("reggae", "sun.dust.fill"), ("caraibe", "sun.dust.fill"), ("afro", "globe.europe.africa.fill"),
            ("latin", "sun.max.fill"), ("arabe", "globe.asia.australia.fill"), ("asie", "globe.asia.australia.fill"),
            ("hip-hop", "mic.fill"), ("hip hop", "mic.fill"), ("rap", "mic.fill"),
            ("rock", "guitars.fill"), ("metal", "flame.fill"), ("punk", "flame.fill"),
            ("pop", "sparkles"), ("dance", "figure.dance"), ("electro", "waveform"), ("house", "waveform"),
            ("jazz", "music.quarternote.3"), ("blues", "music.quarternote.3"), ("soul", "music.quarternote.3"),
            ("r&b", "music.mic"), ("classique", "music.note.house.fill"), ("classical", "music.note.house.fill"),
            ("country", "hat.widebrim.fill"), ("folk", "guitars"), ("indie", "headphones"), ("independ", "headphones"),
            ("bande", "film.fill"), ("film", "film.fill"), ("enfant", "teddybear.fill"), ("famille", "figure.2.and.child.holdinghands"),
            ("gospel", "music.note.list"), ("k-pop", "star.fill"), ("chart", "chart.bar.fill"), ("classement", "chart.bar.fill"),
            ("nouveaut", "sparkles.rectangle.stack.fill"), ("humeurs", "face.smiling"),
        ]
        return table.first { name.contains($0.0) }?.1 ?? "music.note"
    }

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(color.gradient)
            // Grande icône en filigrane, inclinée dans le coin.
            Image(systemName: icon)
                .font(.system(size: 54, weight: .bold))
                .foregroundStyle(.white.opacity(0.35))
                .rotationEffect(.degrees(-12))
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                .padding(.top, 8)
                .padding(.trailing, 6)
                .clipped()
            Text(category.title)
                .font(.headline.weight(.bold))
                .foregroundStyle(.white)
                .shadow(color: .black.opacity(0.25), radius: 2, y: 1)
                .lineLimit(2)
                .padding(12)
        }
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .frame(maxWidth: .infinity)
        .contentShape(Rectangle())
    }
}

/// Carte carrée des carrousels.
struct ItemCard: View {
    let item: MusicItem
    var width: CGFloat = 150
    let onPlay: (Track) -> Void

    var body: some View {
        switch item {
        case .track(let track):
            Button { onPlay(track) } label: {
                label(urls: track.squareArtworkURLs, title: track.title, subtitle: track.artist, circle: false)
            }
            .buttonStyle(.plain)
            .contextMenu { TrackMenu(track: track) }
        case .collection(let collection):
            NavigationLink(value: Route.collection(collection)) {
                label(urls: collection.artworkURLs, title: collection.title,
                      subtitle: collection.subtitle, circle: collection.kind == .artist)
            }
            .buttonStyle(.plain)
            .contextMenu { CollectionMenu(collection: collection) }
        case .category(let category):
            NavigationLink(value: Route.more(title: category.title, link: category.link)) {
                CategoryTile(category: category)
                    .frame(width: width * 1.3, height: 90)
            }
            .buttonStyle(.plain)
        }
    }

    private func label(urls: [URL], title: String, subtitle: String, circle: Bool) -> some View {
        VStack(alignment: circle ? .center : .leading, spacing: 6) {
            ArtworkThumb(urls: urls, size: width, corner: 12, circle: circle)
                .shadow(color: .black.opacity(0.15), radius: 6, y: 3)
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.primary)
                .lineLimit(2)
                .multilineTextAlignment(circle ? .center : .leading)
            if !subtitle.isEmpty {
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .multilineTextAlignment(circle ? .center : .leading)
            }
        }
        .frame(width: width, alignment: circle ? .center : .leading)
        .contentShape(Rectangle())
    }
}

/// Menu commun à tous les titres.
struct TrackMenu: View {
    @Environment(PlayerModel.self) private var player
    @Environment(LibraryStore.self) private var library
    @Environment(DownloadStore.self) private var downloads
    @Environment(Router.self) private var router
    let track: Track
    var onRemove: (() -> Void)?

    var body: some View {
        Section {
            Button("Lire ensuite", systemImage: "text.line.first.and.arrowtriangle.forward") {
                player.playNext(track)
            }
            Button("Ajouter à la file", systemImage: "text.line.last.and.arrowtriangle.forward") {
                player.enqueue(track)
            }
            Button("Lancer la radio", systemImage: "dot.radiowaves.left.and.right") {
                player.startRadio(from: track)
            }
        }
        Section {
            let liked = library.isLiked(track.id)
            Button(liked ? "Je n'aime plus" : "J'aime", systemImage: liked ? "heart.slash" : "heart") {
                player.toggleLike(track)
            }
            if library.isInLibrary(track.id) {
                Button("Retirer de la bibliothèque", systemImage: "minus.circle") { library.removeFromLibrary(track) }
            } else {
                Button("Ajouter à la bibliothèque", systemImage: "plus.circle") { library.addToLibrary(track) }
            }
            AddToPlaylistMenu(tracks: [track])
            switch downloads.state(of: track.id) {
            case .none:
                Button("Télécharger", systemImage: "arrow.down.circle") { downloads.download([track]) }
            case .queued, .downloading:
                Button("Annuler le téléchargement", systemImage: "xmark.circle") { downloads.remove(track.id) }
            case .downloaded:
                Button("Supprimer le téléchargement", systemImage: "trash") { downloads.remove(track.id) }
            }
        }
        Section {
            if let artist = track.artistCollection {
                Button("Voir l'artiste", systemImage: "music.mic") { router.open(.collection(artist)) }
            }
            if let album = track.albumCollection {
                Button("Voir l'album", systemImage: "square.stack") { router.open(.collection(album)) }
            }
            ShareLink(item: track.shareURL) {
                Label("Partager", systemImage: "square.and.arrow.up")
            }
        }
        if let onRemove {
            Section {
                Button("Retirer de la liste", systemImage: "minus.circle", role: .destructive, action: onRemove)
            }
        }
    }
}

/// Sous-menu « Ajouter à une playlist ».
struct AddToPlaylistMenu: View {
    @Environment(LibraryStore.self) private var library
    @Environment(Router.self) private var router
    let tracks: [Track]

    var body: some View {
        Menu("Ajouter à une playlist", systemImage: "text.badge.plus") {
            Button("Nouvelle playlist…", systemImage: "plus") {
                router.newPlaylistTracks = tracks
            }
            ForEach(library.playlists) { playlist in
                Button(playlist.name) { library.add(tracks, to: playlist.id) }
            }
        }
    }
}

/// Menu d'un album, d'une playlist ou d'un artiste.
struct CollectionMenu: View {
    @Environment(PlayerModel.self) private var player
    @Environment(LibraryStore.self) private var library
    let collection: MusicCollection

    var body: some View {
        Section {
            Button("Lire", systemImage: "play.fill") { player.play(collection) }
            Button("Lecture aléatoire", systemImage: "shuffle") { player.play(collection, shuffled: true) }
            Button("Ajouter à la file", systemImage: "text.line.last.and.arrowtriangle.forward") { player.enqueue(collection) }
        }
        Section {
            let saved = library.isSaved(collection.id)
            Button(saved ? "Retirer de la bibliothèque" : "Ajouter à la bibliothèque",
                   systemImage: saved ? "bookmark.slash" : "bookmark") {
                library.toggleSaved(collection)
            }
            ShareLink(item: collection.shareURL) {
                Label("Partager", systemImage: "square.and.arrow.up")
            }
        }
    }
}

/// Boutons « Lecture » et « Aléatoire » en haut des listes.
struct PlayShuffleButtons: View {
    let play: () -> Void
    let shuffle: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Button(action: play) {
                Label("Lecture", systemImage: "play.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.glassProminent)
            Button(action: shuffle) {
                Label("Aléatoire", systemImage: "shuffle")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.glass)
        }
        .controlSize(.large)
        .font(.headline)
    }
}

/// Fenêtre « Nouvelle playlist », déclenchée par `Router.newPlaylistTracks`.
private struct NewPlaylistAlert: ViewModifier {
    @Environment(Router.self) private var router
    @Environment(LibraryStore.self) private var library
    let isActive: Bool
    @State private var name = ""

    func body(content: Content) -> some View {
        content.alert("Nouvelle playlist", isPresented: Binding(
            get: { isActive && router.newPlaylistTracks != nil },
            set: { if !$0 { router.newPlaylistTracks = nil } }
        )) {
            TextField("Nom de la playlist", text: $name)
            Button("Annuler", role: .cancel) { name = "" }
            Button("Créer") {
                let title = name.trimmingCharacters(in: .whitespaces)
                library.createPlaylist(name: title.isEmpty ? "Ma playlist" : title, tracks: router.newPlaylistTracks ?? [])
                name = ""
            }
        } message: {
            if let count = router.newPlaylistTracks?.count, count > 0 {
                Text(count == 1 ? "Le titre y sera ajouté." : "Les \(count) titres y seront ajoutés.")
            }
        }
    }
}

extension View {
    func newPlaylistAlert(isActive: Bool) -> some View {
        modifier(NewPlaylistAlert(isActive: isActive))
    }
}

/// Bouton AirPlay du système.
struct RoutePicker: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let view = AVRoutePickerView()
        view.prioritizesVideoDevices = false
        view.tintColor = .white
        view.activeTintColor = UIColor(Color.novaAccent)
        return view
    }

    func updateUIView(_ uiView: AVRoutePickerView, context: Context) {}
}
