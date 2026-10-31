import CarPlay
import UIKit

/// Interface CarPlay : Accueil, Bibliothèque et Récents, plus l'écran « En cours ».
///
/// CarPlay n'affiche l'app que si sa signature contient l'autorisation
/// `com.apple.developer.carplay-audio`, accordée par Apple. Sans elle, Nova reste
/// pilotable depuis l'écran « En cours » de CarPlay et les commandes au volant.
@MainActor
final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
    private var interfaceController: CPInterfaceController?
    private let client = InnerTubeClient()
    private var player: PlayerModel { PlayerModel.shared }

    private let homeTemplate = CPListTemplate(title: "Accueil", sections: [])
    private let libraryTemplate = CPListTemplate(title: "Bibliothèque", sections: [])
    private let recentsTemplate = CPListTemplate(title: "Récents", sections: [])

    func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene,
                                  didConnect interfaceController: CPInterfaceController) {
        self.interfaceController = interfaceController

        homeTemplate.tabTitle = "Accueil"
        homeTemplate.tabImage = UIImage(systemName: "house.fill")
        homeTemplate.emptyViewTitleVariants = ["Chargement…"]
        libraryTemplate.tabTitle = "Bibliothèque"
        libraryTemplate.tabImage = UIImage(systemName: "square.stack.fill")
        recentsTemplate.tabTitle = "Récents"
        recentsTemplate.tabImage = UIImage(systemName: "clock.fill")
        recentsTemplate.emptyViewTitleVariants = ["Aucune écoute récente"]

        let tabs = CPTabBarTemplate(templates: [homeTemplate, libraryTemplate, recentsTemplate])
        interfaceController.setRootTemplate(tabs, animated: false, completion: nil)

        configureNowPlaying()
        refreshLibrary()
        refreshRecents()
        Task { await loadHome() }
    }

    func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene,
                                  didDisconnectInterfaceController interfaceController: CPInterfaceController) {
        self.interfaceController = nil
    }

    // MARK: - En cours

    private func configureNowPlaying() {
        let shuffle = CPNowPlayingShuffleButton { [weak self] _ in
            self?.player.toggleShuffle()
        }
        let repeatButton = CPNowPlayingRepeatButton { [weak self] _ in
            self?.player.cycleRepeat()
        }
        CPNowPlayingTemplate.shared.updateNowPlayingButtons([shuffle, repeatButton])
    }

    private func showNowPlaying() {
        guard let interfaceController else { return }
        if interfaceController.topTemplate !== CPNowPlayingTemplate.shared {
            interfaceController.pushTemplate(CPNowPlayingTemplate.shared, animated: true, completion: nil)
        }
    }

    // MARK: - Accueil

    private func loadHome() async {
        var page = await PageCache.shared.value(BrowsePage.self, for: "home-\(player.account.isSignedIn)")?.value
        if page == nil { page = try? await client.home() }
        guard let page else {
            homeTemplate.emptyViewTitleVariants = ["Accueil indisponible"]
            homeTemplate.updateSections([])
            return
        }
        let maxSections = CPListTemplate.maximumSectionCount
        let sections = page.shelves.prefix(maxSections).compactMap { shelf -> CPListSection? in
            let items = shelf.items.prefix(12).compactMap { item -> CPListItem? in
                switch item {
                case .track(let track):
                    return trackItem(track) { [weak self] in
                        let tracks = shelf.tracks
                        self?.play(tracks, startAt: tracks.firstIndex(of: track) ?? 0)
                    }
                case .collection(let collection) where collection.kind != .artist:
                    return collectionItem(collection)
                default:
                    return nil
                }
            }
            return items.isEmpty ? nil : CPListSection(items: items, header: shelf.title, sectionIndexTitle: nil)
        }
        homeTemplate.updateSections(Array(sections))
    }

    // MARK: - Bibliothèque

    private func refreshLibrary() {
        let library = player.library
        var rows: [CPListItem] = []

        let liked = CPListItem(text: "Titres likés", detailText: "\(library.liked.count) titres",
                               image: UIImage(systemName: "heart.fill"))
        liked.accessoryType = .disclosureIndicator
        liked.handler = { [weak self] _, completion in
            self?.pushTracks(title: "Titres likés", tracks: library.liked)
            completion()
        }
        rows.append(liked)

        let downloads = CPListItem(text: "Téléchargés", detailText: "\(player.downloads.tracks.count) titres",
                                   image: UIImage(systemName: "arrow.down.circle.fill"))
        downloads.accessoryType = .disclosureIndicator
        downloads.handler = { [weak self] _, completion in
            guard let self else { completion(); return }
            self.pushTracks(title: "Téléchargés", tracks: self.player.downloads.tracks)
            completion()
        }
        rows.append(downloads)

        var sections = [CPListSection(items: rows)]

        let playlists = library.playlists.map { playlist -> CPListItem in
            let item = CPListItem(text: playlist.name, detailText: "\(playlist.tracks.count) titres",
                                  image: UIImage(systemName: "music.note.list"))
            item.accessoryType = .disclosureIndicator
            item.handler = { [weak self] _, completion in
                self?.pushTracks(title: playlist.name, tracks: playlist.tracks)
                completion()
            }
            if let first = playlist.tracks.first { loadImage(first.squareArtworkURLs, into: item) }
            return item
        }
        if !playlists.isEmpty {
            sections.append(CPListSection(items: playlists, header: "Playlists", sectionIndexTitle: nil))
        }

        let saved = library.saved.filter { $0.kind != .artist }.map(collectionItem)
        if !saved.isEmpty {
            sections.append(CPListSection(items: saved, header: "Albums et playlists", sectionIndexTitle: nil))
        }
        libraryTemplate.updateSections(sections)
    }

    private func refreshRecents() {
        let recents = Array(player.library.recents.prefix(CPListTemplate.maximumItemCount))
        let items = recents.enumerated().map { position, track in
            trackItem(track) { [weak self] in self?.play(recents, startAt: position) }
        }
        recentsTemplate.updateSections([CPListSection(items: items)])
    }

    // MARK: - Éléments

    private func trackItem(_ track: Track, action: @escaping () -> Void) -> CPListItem {
        let item = CPListItem(text: track.title, detailText: track.artist, image: UIImage(systemName: "music.note"))
        item.isPlaying = player.current?.id == track.id
        item.handler = { _, completion in
            action()
            completion()
        }
        loadImage(track.squareArtworkURLs, into: item)
        return item
    }

    private func collectionItem(_ collection: MusicCollection) -> CPListItem {
        let item = CPListItem(text: collection.title, detailText: collection.subtitle,
                              image: UIImage(systemName: collection.kind == .album ? "square.stack" : "music.note.list"))
        item.accessoryType = .disclosureIndicator
        item.handler = { [weak self] _, completion in
            guard let self else { completion(); return }
            Task {
                let tracks = (try? await self.client.allTracks(of: collection)) ?? []
                self.pushTracks(title: collection.title, tracks: tracks)
                completion()
            }
        }
        loadImage(collection.artworkURLs, into: item)
        return item
    }

    /// Liste de titres avec « Lecture » et « Aléatoire » en tête.
    private func pushTracks(title: String, tracks: [Track]) {
        guard let interfaceController else { return }
        let playAll = CPListItem(text: "Lecture", detailText: nil, image: UIImage(systemName: "play.fill"))
        playAll.handler = { [weak self] _, completion in
            self?.play(tracks, startAt: 0)
            completion()
        }
        let shuffle = CPListItem(text: "Aléatoire", detailText: nil, image: UIImage(systemName: "shuffle"))
        shuffle.handler = { [weak self] _, completion in
            guard let self else { completion(); return }
            self.player.play(tracks, shuffled: true)
            self.showNowPlaying()
            completion()
        }
        let limit = CPListTemplate.maximumItemCount - 2
        let visible = Array(tracks.prefix(limit))
        let rows = visible.enumerated().map { position, track in
            trackItem(track) { [weak self] in self?.play(tracks, startAt: position) }
        }
        let template = CPListTemplate(title: title, sections: [
            CPListSection(items: tracks.isEmpty ? [] : [playAll, shuffle]),
            CPListSection(items: rows),
        ])
        template.emptyViewTitleVariants = ["Aucun titre"]
        interfaceController.pushTemplate(template, animated: true, completion: nil)
    }

    private func play(_ tracks: [Track], startAt position: Int) {
        guard !tracks.isEmpty else { return }
        player.play(tracks, startAt: position)
        showNowPlaying()
        refreshRecents()
    }

    private func loadImage(_ urls: [URL], into item: CPListItem) {
        guard !urls.isEmpty else { return }
        Task {
            if let image = await ImageLoader.load(urls) {
                item.setImage(image)
            }
        }
    }
}
