import SwiftUI
import UniformTypeIdentifiers

struct LibraryRestoreSection: View {
    @Environment(LibraryStore.self) private var library
    @State private var picker = false
    @State private var working = false
    @State private var message: String?
    @State private var errorText: String?

    var body: some View {
        Section {
            if let computer = PCSync.shared.pairedComputer {
                Button("Restaurer depuis " + computer, systemImage: "desktopcomputer.and.arrow.down") {
                    run { try await PCSync.shared.restore(library: library) }
                }
                .disabled(working || PCSync.shared.isSyncing)
            }
            Button("Restaurer une sauvegarde Nova", systemImage: "doc.badge.arrow.up") { picker = true }
                .disabled(working || PCSync.shared.isSyncing)
            if working { ProgressView("Restauration de la bibliothèque…") }
            if let message { Text(message).font(.caption).foregroundStyle(.secondary) }
        } header: {
            Text("Retrouver ma bibliothèque")
        } footer: {
            Text("Depuis le PC : Importer → Bibliothèque iPhone ↔ PC. Scanne le QR code et choisis « Restaurer depuis ce PC », ou exporte une sauvegarde JSON et ouvre-la ici. Playlists, likes, historique et récap annuel sont fusionnés sans doublons. Les fichiers audio locaux sont à réimporter sur cet appareil.")
        }
        .fileImporter(isPresented: $picker, allowedContentTypes: [.json], allowsMultipleSelection: false) { result in
            run {
                guard let url = try result.get().first else { return "" }
                let access = url.startAccessingSecurityScopedResource()
                defer { if access { url.stopAccessingSecurityScopedResource() } }
                let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard size <= 300_000_000 else { throw CocoaError(.fileReadTooLarge) }
                return try library.restoreData(Data(contentsOf: url)).message
            }
        }
        .alert("Restauration impossible", isPresented: Binding(get: { errorText != nil }, set: { if !$0 { errorText = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(errorText ?? "") }
    }

    private func run(_ action: @escaping @MainActor () async throws -> String) {
        working = true
        message = nil
        Task {
            defer { working = false }
            do { message = try await action() }
            catch is DecodingError { errorText = "Ce fichier n’est pas une sauvegarde Nova compatible. Exporte-le depuis Nova sur le PC." }
            catch { errorText = error.localizedDescription }
        }
    }
}
