# Voxcord 0.5.1 — native Rust client

Voxcord uses Rust and Slint for the complete desktop interface. It does not embed Discord's website, Electron or WebView2. The engine is a GPL-3.0-or-later fork of [Yapfast](https://github.com/yapfast/yapfast), pinned to `28174c7227e9b5a7a7dd222378086e88a62cbdb1`; `yapfast.patch` contains the complete changes, including branding and the Windows icon. Every build distributes the patched source and dependency notices alongside the portable executable.

## This build

- Replace the speech-bubble face with a segmented V signal mark. A dark violet app tile and lavender mark identify the Windows executable and installer; a monochrome version is used in the UI, with a separate lower-right unread badge in the tray. The ICO contains 16, 20, 24, 32, 40, 48, 64, 128 and 256 px images.

- Preserve a camera's RTP reassembly when subscriptions change or op 12 repeats. Restart only the camera that was hidden/replaced; periodically request an initial keyframe and request another after a decoder error.
- Migrate existing profiles to a quiet taskbar once. Flashing remains an explicit opt-in, and turning it off cancels an existing attention request.
- Measure FPS from complete frames sent through UDP rather than the selected preset; show the target separately. Skip missed capture slots instead of catching them up in bursts. Actual size, encoder, measured bitrate, target bitrate and retransmissions remain visible in call connection details.
- Apply the Voxcord name and vector mark to the native window, UI copy, tray, executable, portable launcher and Windows installer. Retain the earlier NovaCord Native data directory and credential namespace to preserve linked accounts. The installer's stable AppId also allows upgrading the previous native test build.
- Retain native Discord soundboard search, messages, servers, DMs, cameras, voice and Go Live from the engine.

## Verification

The workflow builds the Windows application and test executables, runs camera subscription/reassembly tests, RTP tests and the screen media tests on Windows, then installs the EXE, runs its smoke test and checks that a native window opens. These are automated regression/startup checks. They do not prove successful multi-person calls or physical camera/audio behavior on a user's machine.

The old Tauri 0.4.5 remains separate. Its personal sound library/microphone injection, Myinstants remote and phone controller and customizable action shortcuts (leave call / toggle camera) have **not yet been ported** to this native engine. This is not complete feature parity with NovaCord 0.4.5. The old WebView's error 2012 cannot be reproduced by a startup test of this engine; multi-camera behavior still needs a real Discord call test.

Download the `Voxcord-Windows-Setup` artifact from the successful workflow run and extract `Voxcord-Setup.exe`. The `Voxcord-portable-and-source` artifact contains the portable version and corresponding source.

## Logo assets

`voxcord.svg` is the full application icon; `voxcord-mark.svg` is the transparent monochrome symbol. Both share the same two paths. The engine patch includes these SVGs and the Windows ICO. To regenerate the ICO after changing the application SVG, use the engine's `scripts/make-windows-icon` (ImageMagick). Keep the monochrome viewBox at 24 units so the tray unread badge stays aligned.
