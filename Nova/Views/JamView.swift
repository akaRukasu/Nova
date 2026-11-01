import SwiftUI

/// Page du Jam : lancer, rejoindre, voir la file commune.
struct JamView: View {
    @Environment(\.dismiss) private var dismiss
    private let jam = JamSession.shared

    var body: some View {
        @Bindable var jam = jam
        NavigationStack {
            List {
                if let message = jam.message {
                    Section {
                        Label(message, systemImage: "info.circle")
                            .foregroundStyle(.secondary)
                    }
                }
                switch jam.role {
                case .none: startSections
                case .host: hostSections
                case .guest: guestSections
                }
            }
            .navigationTitle("Jam")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("OK") { dismiss() }
                }
            }
            .onAppear {
                jam.message = nil
                jam.startBrowsing()
            }
            .onDisappear { jam.stopBrowsing() }
            .animation(.default, value: jam.role)
            .animation(.default, value: jam.nearby)
        }
    }

    // MARK: Avant le Jam

    @ViewBuilder private var startSections: some View {
        @Bindable var jam = jam
        Section {
            VStack(spacing: 12) {
                Image(systemName: "person.2.wave.2.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(Color.novaAccent)
                Text("Écoutez ensemble")
                    .font(.title2.weight(.bold))
                Text("Lance un Jam : tes amis à côté de toi le rejoignent depuis Nova, ajoutent leurs titres à la file et peuvent écouter en même temps sur leur iPhone.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .listRowBackground(Color.clear)
        }
        Section("Ton prénom") {
            TextField("Visible par les autres", text: $jam.displayName)
                .textInputAutocapitalization(.words)
                .submitLabel(.done)
        }
        Section {
            Button {
                jam.startHosting()
            } label: {
                Label("Lancer un Jam", systemImage: "play.circle.fill")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())
        }
        Section {
            if jam.nearby.isEmpty {
                HStack(spacing: 12) {
                    ProgressView()
                    Text("Recherche des Jams autour de toi…")
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(jam.nearby) { nearby in
                HStack {
                    Image(systemName: "person.2.wave.2")
                        .foregroundStyle(Color.novaAccent)
                    Text("Jam de \(nearby.name)")
                    Spacer()
                    if jam.isConnecting {
                        ProgressView()
                    } else {
                        Button("Rejoindre") { jam.join(nearby) }
                            .buttonStyle(.bordered)
                    }
                }
            }
        } header: {
            Text("Jams à proximité")
        } footer: {
            Text("Tes amis doivent avoir Nova, avec le Wi-Fi ou le Bluetooth activé. La première fois, autorise Nova à accéder au réseau local.")
        }
    }

    // MARK: Hôte

    @ViewBuilder private var hostSections: some View {
        @Bindable var jam = jam
        let participants = jam.state?.participants ?? []
        Section {
            if participants.isEmpty {
                Label("En attente d'amis… Ils voient ton Jam en ouvrant Jam dans le lecteur de Nova.",
                      systemImage: "hourglass")
                    .foregroundStyle(.secondary)
            }
            ForEach(participants, id: \.self) { name in
                Label(name, systemImage: "person.crop.circle.fill")
            }
            Toggle("Les invités contrôlent la lecture", isOn: $jam.guestsCanControl)
        } header: {
            Text("Ton Jam est ouvert")
        } footer: {
            Text("La musique sort de ton iPhone (ou de l'enceinte AirPlay choisie). Chacun peut ajouter des titres depuis le menu « … » d'un titre.")
        }
        queueSections(jam.state)
        Section {
            Button("Terminer le Jam", role: .destructive) { jam.leave() }
        }
    }

    // MARK: Invité

    @ViewBuilder private var guestSections: some View {
        @Bindable var jam = jam
        let state = jam.state
        Section {
            ForEach(state?.participants ?? [], id: \.self) { name in
                Label(name, systemImage: "person.crop.circle")
            }
            Toggle("Écouter aussi sur cet iPhone", isOn: $jam.listenAlong)
        } header: {
            Text("Jam de \(state?.hostName ?? "…")")
        } footer: {
            Text("Pour ajouter un titre : menu « … » du titre, puis « Ajouter au Jam ».")
        }
        if state?.guestsCanControl == true {
            Section {
                HStack(spacing: 40) {
                    Button { jam.command(.previous) } label: { Image(systemName: "backward.fill") }
                    Button { jam.command(state?.isPlaying == true ? .pause : .play) } label: {
                        Image(systemName: state?.isPlaying == true ? "pause.fill" : "play.fill")
                            .font(.title)
                    }
                    Button { jam.command(.next) } label: { Image(systemName: "forward.fill") }
                }
                .font(.title2)
                .buttonStyle(.plain)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
            }
        }
        queueSections(state)
        Section {
            Button("Quitter le Jam", role: .destructive) { jam.leave() }
        }
    }

    // MARK: File commune

    @ViewBuilder private func queueSections(_ state: JamState?) -> some View {
        if let current = state?.current {
            Section("En cours") {
                row(current, addedBy: state?.addedBy[current.id])
            }
        }
        let upcoming = state?.upcoming ?? []
        if !upcoming.isEmpty {
            Section("À suivre") {
                ForEach(Array(upcoming.prefix(40).enumerated()), id: \.offset) { _, track in
                    row(track, addedBy: state?.addedBy[track.id])
                }
            }
        }
    }

    private func row(_ track: Track, addedBy: String?) -> some View {
        HStack(spacing: 12) {
            ArtworkThumb(track: track, size: 44, corner: 6)
            VStack(alignment: .leading, spacing: 2) {
                Text(track.title)
                    .lineLimit(1)
                Text(addedBy.map { "\(track.artist) · ajouté par \($0)" } ?? track.artist)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }
}
