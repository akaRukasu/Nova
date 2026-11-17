package com.akarukasu.nova;

import android.content.Context;
import android.net.Uri;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Collections;
import java.util.Locale;
import java.util.UUID;

/** Transfert binaire vers le PC associé, sans encodage base64 ni chargement du fichier en mémoire. */
final class LocalAudioTransfer {
    private final Context context;
    private final String host, token;
    private final int port;
    private final InetAddress address;

    LocalAudioTransfer(Context context, String host, int port, String token) throws Exception {
        if (host == null || !host.matches("[0-9]{1,3}(\\.[0-9]{1,3}){3}") || port < 1 || port > 65535
                || token == null || !token.matches("[a-f0-9]{32}")) throw new IOException("Association invalide.");
        address = InetAddress.getByName(host);
        if (!(address instanceof Inet4Address) || !(address.isSiteLocalAddress() || address.isLinkLocalAddress())) throw new IOException("Le PC doit être sur le réseau local.");
        this.context = context; this.host = host; this.port = port; this.token = token;
    }

    void sync(JSONArray tracks) throws Exception {
        LocalAudioFiles library = new LocalAudioFiles(context);
        for (int i = 0; i < tracks.length(); i++) {
            JSONObject track = tracks.getJSONObject(i);
            String filename = track.optString("localFileName");
            if (!filename.matches("[a-f0-9]{64}\\.[a-z0-9]{1,8}") || !("local:" + filename.substring(0, 64)).equals(track.optString("id"))) continue;
            File local = null;
            try { local = new File(Uri.parse(library.url(track.getString("id"))).getPath()); } catch (Exception ignored) {}
            if (local != null) {
                int status;
                try (Reply reply = request("HEAD", filename, null)) { status = reply.status; }
                if (status == 200) continue;
                if (status != 404) throw new IOException("Transfert audio refusé (" + status + ").");
                try (Reply reply = request("POST", filename, local)) {
                    if (reply.status != 200) throw new IOException("Envoi audio refusé (" + reply.status + ").");
                }
            } else {
                File staging = new File(context.getCacheDir(), UUID.randomUUID() + filename.substring(64));
                try (Reply reply = request("GET", filename, null)) {
                    if (reply.status != 200 || reply.length < 1 || reply.length > 1_000_000_000L) throw new IOException("Fichier audio indisponible sur le PC.");
                    MessageDigest digest = MessageDigest.getInstance("SHA-256");
                    try (OutputStream output = new FileOutputStream(staging)) {
                        byte[] buffer = new byte[65536];
                        long remaining = reply.length;
                        while (remaining > 0) {
                            int count = reply.input.read(buffer, 0, (int)Math.min(buffer.length, remaining));
                            if (count < 0) throw new IOException("Transfert audio interrompu.");
                            output.write(buffer, 0, count); digest.update(buffer, 0, count); remaining -= count;
                        }
                    }
                    StringBuilder hash = new StringBuilder();
                    for (byte value : digest.digest()) hash.append(String.format(Locale.ROOT, "%02x", value & 255));
                    if (!filename.startsWith(hash + ".")) throw new IOException("Le fichier reçu est incomplet.");
                    JSONObject result = library.importFiles(Collections.singletonList(Uri.fromFile(staging)));
                    if (result.getJSONArray("tracks").length() != 1) throw new IOException("Format audio non pris en charge par cet appareil.");
                } finally { staging.delete(); }
            }
        }
    }

    private Reply request(String method, String filename, File upload) throws Exception {
        Socket socket = new Socket();
        try {
            socket.connect(new InetSocketAddress(address, port), 4000); socket.setSoTimeout(180000);
            OutputStream output = socket.getOutputStream();
            long length = upload == null ? 0 : upload.length();
            if (length > 1_000_000_000L) throw new IOException("Fichier audio trop volumineux.");
            String headers = method + " /audio/" + filename + " HTTP/1.1\r\nHost: " + host + ":" + port
                    + "\r\nConnection: close\r\nX-Nova-Token: " + token + "\r\nContent-Length: " + length + "\r\n\r\n";
            output.write(headers.getBytes(StandardCharsets.US_ASCII));
            if (upload != null) try (InputStream input = new FileInputStream(upload)) {
                byte[] buffer = new byte[65536]; int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            }
            output.flush();
            InputStream input = new BufferedInputStream(socket.getInputStream());
            ByteArrayOutputStream header = new ByteArrayOutputStream(); int tail = 0;
            while (tail != 0x0D0A0D0A) {
                int b = input.read();
                if (b < 0 || header.size() > 8192) throw new IOException("Réponse du PC invalide.");
                header.write(b); tail = (tail << 8) | b;
            }
            String[] lines = header.toString("US-ASCII").split("\r\n");
            int status = Integer.parseInt(lines[0].split(" ")[1]); long size = -1;
            for (String line : lines) if (line.toLowerCase(Locale.ROOT).startsWith("content-length:")) size = Long.parseLong(line.substring(15).trim());
            return new Reply(socket, input, status, size);
        } catch (Exception error) { socket.close(); throw error; }
    }

    private static final class Reply implements AutoCloseable {
        final Socket socket; final InputStream input; final int status; final long length;
        Reply(Socket socket, InputStream input, int status, long length) { this.socket = socket; this.input = input; this.status = status; this.length = length; }
        public void close() throws IOException { socket.close(); }
    }
}
