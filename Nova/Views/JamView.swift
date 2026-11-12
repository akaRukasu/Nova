import CoreImage.CIFilterBuiltins
import SwiftUI
import UIKit

/// Page du Jam : lancer, rejoindre, voir la file commune.
struct JamView: View {
    @Environment(\.dismiss) private var dismiss
    private let jam = JamSession.shared
    @State private var circleDraft = ""
    @State private var invitationDraft = ""
    @State private var configuringCircle = false
    @State private var createAfterSetup = false
    @State private var copiedInvitation: URL?
    @FocusState private var circleFocused: Bool

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
                if jam.pendingInvitation != nil {
                    Section("Invitation à un Jam") {
                        Button("Rejoindre la session", systemImage: "person.crop.circle.badge.plus") {
                            Task { await jam.joinInvitation() }
                        }
                        .disabled(jam.isConnecting)
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
                circleDraft = jam.circleLink
                jam.startBrowsing()
            }
            .task(id: jam.circleLink) {
                while !Task.isCancelled {
                    await jam.discoverRemote()
                    try? await Task.sleep(for: .seconds(2.5))
                }
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
            VStack(alignment: .leading, spacing: 12) {
                Image(systemName: "person.2.wave.2.fill")
                    .font(.system(size: 32, weight: .semibold))
                Text("Écoutez ensemble")
                    .font(.largeTitle.bold())
                Text("Une file commune. Chacun peut proposer le prochain titre.")
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.85))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .foregroundStyle(.white)
            .padding(20)
            .background {
                RoundedRectangle(cornerRadius: 22)
                    .fill(LinearGradient(colors: [Color(red: 0.16, green: 0.12, blue: 0.32), Color(red: 0.49, green: 0.13, blue: 0.41)],
                                         startPoint: .bottomLeading, endPoint: .topTrailing))
            }
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
        }
        Section("Ton prénom") {
            TextField("Visible par les autres", text: $jam.displayName)
                .textInputAutocapitalization(.words)
                .submitLabel(.done)
        }
        Section("À distance") {
            Button("Créer un Jam à distance", systemImage: "globe") {
                if jam.circleLink.isEmpty {
                    createAfterSetup = true
                    configuringCircle = true
                    circleFocused = true
                } else {
                    Task { await jam.connectRemote() }
                }
            }
            .disabled(jam.isConnecting)
            if configuringCircle {
                Text("Colle une fois le lien de configuration du cercle sur cet appareil.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                SecureField("Lien du cercle hôte", text: $circleDraft)
                    .focused($circleFocused)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button(createAfterSetup ? "Enregistrer et créer le Jam" : "Enregistrer le lien", systemImage: "link") {
                    guard jam.saveCircle(circleDraft) else { return }
                    let create = createAfterSetup
                    configuringCircle = false
                    createAfterSetup = false
                    if create { Task { await jam.connectRemote() } }
                }
                .disabled(jam.isConnecting || (createAfterSetup && circleDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
            } else if !jam.circleLink.isEmpty {
                Button("Configuration hôte", systemImage: "gearshape") {
                    circleDraft = jam.circleLink
                    configuringCircle = true
                }
            }
            TextField("Lien d’invitation reçu", text: $invitationDraft)
                .textContentType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            if !invitationDraft.isEmpty {
                Button("Ouvrir l’invitation", systemImage: "link") {
                    guard let url = URL(string: invitationDraft.trimmingCharacters(in: .whitespacesAndNewlines)),
                          jam.receiveInvitation(url) else {
                        jam.message = "Ce lien ne correspond pas à une invitation Jam."
                        return
                    }
                    invitationDraft = ""
                }
            }
            if let error = jam.relayError {
                Label(error, systemImage: "info.circle").foregroundStyle(.secondary)
            }
            if !jam.circleLink.isEmpty {
                if jam.remoteRooms.isEmpty && jam.relayError == nil {
                    Text("Aucun Jam ouvert dans ton cercle.").foregroundStyle(.secondary)
                }
                ForEach(jam.remoteRooms) { room in
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Jam de " + room.name).font(.headline)
                            Text("\(room.people) en ligne").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Rejoindre") { Task { await jam.connectRemote(room: room) } }
                            .buttonStyle(.bordered)
                            .disabled(jam.isConnecting)
                    }
                }
            }
        }
        Section {
            Button {
                jam.startHosting()
            } label: {
                Label("Lancer en local", systemImage: "play.circle.fill")
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
            Text("Ou scanne le QR code du Jam d'un ami avec l'appareil photo de ton iPhone. Tes amis doivent avoir Nova, avec le Wi-Fi ou le Bluetooth activé. La première fois, autorise Nova à accéder au réseau local.")
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
        if let url = jam.joinURL {
            Section {
                VStack(spacing: 12) {
                    QRCodeView(text: url.absoluteString)
                        .frame(width: 200, height: 200)
                        .padding(14)
                        .background(.white, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    Text("Code \(jam.code ?? "")")
                        .font(.headline.monospaced())
                    ShareLink(item: url, subject: Text("Rejoins mon Jam Nova"),
                              message: Text("Ouvre ce lien sur ton iPhone (Nova installé, à côté de moi) pour rejoindre mon Jam.")) {
                        Label("Envoyer le lien", systemImage: "square.and.arrow.up")
                    }
                    .buttonStyle(.bordered)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            } header: {
                Text("Inviter avec le QR code")
            } footer: {
                Text("Tes amis scannent ce code avec l'appareil photo de leur iPhone : Nova s'ouvre et rejoint ton Jam.")
            }
        }
        if let url = jam.invitationURL {
            remoteInvitation(url)
        }
        queueSections(jam.state)
        Section {
            Button("Terminer le Jam", role: .destructive) { Task { await jam.leaveConfirmed() } }
        }
    }

    private func remoteInvitation(_ url: URL) -> some View {
        Section("Invitation au Jam") {
            VStack(spacing: 8) {
                QRCodeView(text: url.absoluteString)
                    .frame(width: 188, height: 188)
                    .padding(16)
                    .background(.white, in: RoundedRectangle(cornerRadius: 16))
                    .accessibilityLabel("QR code d’invitation au Jam")
                Text("À scanner avec l’appareil photo")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            Button(copiedInvitation == url ? "Lien copié" : "Copier le lien",
                   systemImage: copiedInvitation == url ? "checkmark" : "doc.on.doc") {
                UIPasteboard.general.string = url.absoluteString
                copiedInvitation = url
            }
            ShareLink(item: url) { Label("Partager l’invitation", systemImage: "square.and.arrow.up") }
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
            Button("Quitter le Jam", role: .destructive) { Task { await jam.leaveConfirmed() } }
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

/// QR code net (agrandi sans lissage).
struct QRCodeView: View {
    let text: String

    var body: some View {
        if let image = Self.image(for: text) {
            Image(uiImage: image)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
        } else {
            Image(systemName: "qrcode")
                .resizable()
                .scaledToFit()
                .foregroundStyle(.black)
        }
    }

    private static func image(for text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)),
              let cgImage = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cgImage)
    }
}
