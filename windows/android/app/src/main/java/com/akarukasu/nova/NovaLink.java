package com.akarukasu.nova;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Nova sur le réseau local, comme sur PC : l'iPhone associé (QR code) envoie sa bibliothèque et pilote
 * la lecture (port 47822, annonce « _nova-sync._tcp ») ; Jam entre appareils (annonce UDP 47821, messages
 * JSON ligne par ligne). Les messages reçus partent vers l'interface par {@link Relay}.
 */
class NovaLink {
    interface Relay { void emit(String channel, String argsJson); }

    private static final int SYNC_PORT = 47822;
    private static final int JAM_PORT = 47821;

    private final Context context;
    private final Relay relay;
    private final SharedPreferences prefs;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final ScheduledExecutorService timers = Executors.newSingleThreadScheduledExecutor();

    private ServerSocket syncServer;
    private int port;
    private volatile String remoteState = null;
    private NsdManager nsd;
    private NsdManager.RegistrationListener registration;

    NovaLink(Context context, Relay relay) {
        this.context = context.getApplicationContext();
        this.relay = relay;
        prefs = this.context.getSharedPreferences("nova-link", Context.MODE_PRIVATE);
        if (!prefs.contains("pcId")) {
            prefs.edit().putString("pcId", UUID.randomUUID().toString()).putString("token", newToken()).apply();
        }
    }

    private static String newToken() {
        byte[] bytes = new byte[16];
        new SecureRandom().nextBytes(bytes);
        StringBuilder hex = new StringBuilder();
        for (byte b : bytes) hex.append(String.format(Locale.ROOT, "%02x", b));
        return hex.toString();
    }

    String deviceName() {
        return (Build.MODEL == null || Build.MODEL.isEmpty()) ? "Android" : Build.MODEL;
    }

    // MARK: Synchronisation et télécommande (iPhone)

    void start() {
        pool.execute(() -> {
            try {
                ServerSocket server = new ServerSocket();
                server.setReuseAddress(true);
                try {
                    server.bind(new InetSocketAddress(SYNC_PORT));
                } catch (Exception busy) {
                    server.close();
                    server = new ServerSocket(0);
                }
                syncServer = server;
                port = server.getLocalPort();
                advertise();
                while (!server.isClosed()) {
                    Socket client = server.accept();
                    pool.execute(() -> handle(client));
                }
            } catch (Exception ignored) { }
        });
    }

    private void advertise() {
        try {
            nsd = (NsdManager) context.getSystemService(Context.NSD_SERVICE);
            NsdServiceInfo info = new NsdServiceInfo();
            info.setServiceName("Nova " + deviceName());
            info.setServiceType("_nova-sync._tcp");
            info.setPort(port);
            info.setAttribute("id", prefs.getString("pcId", ""));
            registration = new NsdManager.RegistrationListener() {
                @Override public void onRegistrationFailed(NsdServiceInfo s, int e) { }
                @Override public void onUnregistrationFailed(NsdServiceInfo s, int e) { }
                @Override public void onServiceRegistered(NsdServiceInfo s) { }
                @Override public void onServiceUnregistered(NsdServiceInfo s) { }
            };
            nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, registration);
        } catch (Exception ignored) { }
    }

    JSONObject info() throws Exception {
        JSONObject result = new JSONObject();
        result.put("pcId", prefs.getString("pcId", ""));
        result.put("token", prefs.getString("token", ""));
        result.put("port", port);
        result.put("address", localAddress());
        result.put("name", deviceName());
        result.put("paired", prefs.getBoolean("paired", false));
        if (prefs.contains("phoneName")) result.put("phoneName", prefs.getString("phoneName", ""));
        if (prefs.contains("lastSync")) result.put("lastSync", prefs.getLong("lastSync", 0));
        return result;
    }

    void unpair() {
        prefs.edit().putString("token", newToken()).putBoolean("paired", false).remove("phoneName").remove("lastSync").apply();
    }

    interface HistoryCallback { void complete(String history, String error); }

    void exchangeHistory(String host, int port, String token, String json, HistoryCallback callback) {
        pool.execute(() -> {
            try {
                if (host == null || !host.matches("[0-9]{1,3}(\\.[0-9]{1,3}){3}") || port < 1 || port > 65535
                        || token == null || !token.matches("[0-9a-f]{32}") || json == null) {
                    throw new IllegalArgumentException("Lien de synchronisation Nova invalide.");
                }
                InetAddress address = InetAddress.getByName(host);
                if (!(address instanceof Inet4Address) || !(address.isSiteLocalAddress() || address.isLinkLocalAddress())) {
                    throw new IllegalArgumentException("Le PC doit être sur ton réseau local.");
                }
                byte[] body = json.getBytes(StandardCharsets.UTF_8);
                if (body.length > 4_000_000) throw new IllegalArgumentException("L’historique est trop volumineux.");
                try (Socket socket = new Socket()) {
                    socket.connect(new InetSocketAddress(address, port), 4000);
                    socket.setSoTimeout(12000);
                    String header = "POST /history HTTP/1.1\r\nHost: " + host + ":" + port
                            + "\r\nConnection: close\r\nContent-Type: application/json\r\nX-Nova-Token: " + token
                            + "\r\nX-Nova-Device: Android\r\nContent-Length: " + body.length + "\r\n\r\n";
                    OutputStream out = socket.getOutputStream();
                    out.write(header.getBytes(StandardCharsets.US_ASCII));
                    out.write(body);
                    out.flush();
                    InputStream in = new BufferedInputStream(socket.getInputStream());
                    ByteArrayOutputStream response = new ByteArrayOutputStream();
                    int tail = 0;
                    while (tail != 0x0D0A0D0A) {
                        int value = in.read();
                        if (value < 0 || response.size() >= 8192) throw new java.io.IOException();
                        response.write(value);
                        tail = (tail << 8) | value;
                    }
                    String[] lines = response.toString("US-ASCII").split("\r\n");
                    if (lines[0].contains(" 403 ")) {
                        callback.complete(null, "Le PC a refusé l’association. Copie un nouveau lien dans Nova pour Windows.");
                        return;
                    }
                    int length = -1;
                    for (String line : lines) {
                        if (line.toLowerCase(Locale.ROOT).startsWith("content-length:")) {
                            length = Integer.parseInt(line.substring(15).trim());
                        }
                    }
                    if (!lines[0].contains(" 200 ") || length < 1 || length > 4_000_000) {
                        callback.complete(null, "Mets Nova à jour sur le PC pour synchroniser l’historique.");
                        return;
                    }
                    byte[] payload = new byte[length];
                    for (int offset = 0; offset < length;) {
                        int count = in.read(payload, offset, length - offset);
                        if (count < 0) throw new java.io.IOException();
                        offset += count;
                    }
                    callback.complete(new String(payload, StandardCharsets.UTF_8), null);
                }
            } catch (IllegalArgumentException error) {
                callback.complete(null, error.getMessage());
            } catch (Exception error) {
                callback.complete(null, "PC inaccessible. Ouvre Nova sur le PC et vérifie le réseau local.");
            }
        });
    }

    void setRemoteState(String state) {
        remoteState = state;
    }

    private String stateOrDefault() {
        String state = remoteState;
        if (state != null) return state;
        return "{\"name\":" + JSONObject.quote(deviceName()) + ",\"track\":null,\"queue\":[],\"playing\":false,\"time\":0,\"duration\":0,\"volume\":0.8}";
    }

    private void handle(Socket socket) {
        try (Socket client = socket) {
            client.setSoTimeout(30_000);
            InputStream in = client.getInputStream();
            ByteArrayOutputStream head = new ByteArrayOutputStream();
            // En-tête : jusqu'à la ligne vide (\r\n\r\n).
            int last = 0;
            while (last != 0x0D0A0D0A) {
                int b = in.read();
                if (b < 0 || head.size() > 65_536) return;
                head.write(b);
                last = (last << 8) | b;
            }
            String[] lines = head.toString("UTF-8").split("\r\n");
            String[] request = lines[0].split(" ");
            if (request.length < 2) return;
            String method = request[0], path = request[1];
            Map<String, String> headers = new LinkedHashMap<>();
            for (int i = 1; i < lines.length; i++) {
                int colon = lines[i].indexOf(':');
                if (colon > 0) headers.put(lines[i].substring(0, colon).trim().toLowerCase(Locale.ROOT), lines[i].substring(colon + 1).trim());
            }
            long length = 0;
            try { length = Long.parseLong(headers.getOrDefault("content-length", "0")); } catch (Exception ignored) { }
            if (length > 150_000_000L) { respond(client, 413, "text/plain", "trop gros"); return; }
            byte[] body = new byte[(int) length];
            int read = 0;
            while (read < length) {
                int n = in.read(body, read, (int) length - read);
                if (n < 0) break;
                read += n;
            }
            String token = prefs.getString("token", "");
            boolean authorized = token.equals(headers.get("x-nova-token"));

            if ("GET".equals(method) && path.startsWith("/status")) {
                JSONObject status = new JSONObject();
                status.put("app", "nova-android");
                status.put("pcId", prefs.getString("pcId", ""));
                status.put("name", deviceName());
                respond(client, 200, "application/json", status.toString());
            } else if (path.startsWith("/remote/")) {
                if (!authorized) { respond(client, 403, "text/plain", ""); return; }
                if ("GET".equals(method)) { respond(client, 200, "application/json", stateOrDefault()); return; }
                String command = new String(body, StandardCharsets.UTF_8);
                relay.emit("remote:command", "[" + new JSONObject(command) + "]");
                // L'interface applique la commande puis publie le nouvel état : renvoyé un instant après.
                Thread.sleep(250);
                respond(client, 200, "application/json", stateOrDefault());
            } else if ("POST".equals(method) && path.startsWith("/sync")) {
                if (!authorized) { respond(client, 403, "text/plain", ""); return; }
                JSONObject parsed = new JSONObject(new String(body, StandardCharsets.UTF_8));
                JSONObject library = parsed.optJSONObject("library");
                if (library != null) {
                    if (parsed.has("shared")) library.put("shared", parsed.get("shared"));
                } else {
                    library = parsed;
                }
                String phone = headers.getOrDefault("x-nova-device", "iPhone");
                relay.emit("phone:library", "[" + library + "," + JSONObject.quote(phone) + "]");
                prefs.edit().putBoolean("paired", true).putString("phoneName", phone).putLong("lastSync", System.currentTimeMillis()).apply();
                JSONObject summary = new JSONObject();
                JSONArray playlists = library.optJSONArray("playlists");
                summary.put("playlists", playlists == null ? 0 : playlists.length());
                summary.put("tracks", countTracks(library));
                respond(client, 200, "application/json", summary.toString());
            } else {
                respond(client, 200, "text/plain; charset=utf-8", "Nova pour Android");
            }
        } catch (Exception ignored) { }
    }

    private static int countTracks(JSONObject library) {
        Set<String> ids = new HashSet<>();
        for (String key : new String[] { "liked", "addedTracks" }) addIds(library.optJSONArray(key), ids);
        JSONArray playlists = library.optJSONArray("playlists");
        if (playlists != null) for (int i = 0; i < playlists.length(); i++) {
            JSONObject playlist = playlists.optJSONObject(i);
            if (playlist != null) addIds(playlist.optJSONArray("tracks"), ids);
        }
        return ids.size();
    }

    private static void addIds(JSONArray tracks, Set<String> ids) {
        if (tracks == null) return;
        for (int i = 0; i < tracks.length(); i++) {
            JSONObject track = tracks.optJSONObject(i);
            if (track != null && track.has("id")) ids.add(track.optString("id"));
        }
    }

    private static void respond(Socket client, int status, String type, String text) throws Exception {
        byte[] data = text.getBytes(StandardCharsets.UTF_8);
        String reason = status == 200 ? "OK" : status == 403 ? "Forbidden" : status == 413 ? "Payload Too Large" : "Error";
        String head = "HTTP/1.1 " + status + " " + reason + "\r\nContent-Type: " + type + "\r\nContent-Length: " + data.length
                + "\r\nConnection: close\r\n\r\n";
        OutputStream out = client.getOutputStream();
        out.write(head.getBytes(StandardCharsets.UTF_8));
        out.write(data);
        out.flush();
    }

    /** Adresse IPv4 de l'appareil sur le réseau local (Wi-Fi ou partage de connexion). */
    static String localAddress() {
        try {
            List<String> found = new ArrayList<>();
            for (NetworkInterface network : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!network.isUp() || network.isLoopback()) continue;
                for (InetAddress address : Collections.list(network.getInetAddresses())) {
                    if (address instanceof Inet4Address && !address.isLoopbackAddress()) {
                        String name = network.getName();
                        if (name.startsWith("wlan") || name.startsWith("ap") || name.startsWith("eth")) found.add(0, address.getHostAddress());
                        else found.add(address.getHostAddress());
                    }
                }
            }
            return found.isEmpty() ? "127.0.0.1" : found.get(0);
        } catch (Exception e) {
            return "127.0.0.1";
        }
    }

    static List<String> localAddresses() {
        List<String> result = new ArrayList<>();
        try {
            for (NetworkInterface network : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                for (InetAddress address : Collections.list(network.getInetAddresses())) {
                    if (address instanceof Inet4Address && !address.isLoopbackAddress()) result.add(address.getHostAddress());
                }
            }
        } catch (Exception ignored) { }
        return result;
    }

    // MARK: Jam (même protocole que sur PC)

    private ServerSocket jamServer;
    private DatagramSocket announcer;
    private final Map<Socket, String> guests = new ConcurrentHashMap<>();
    private Socket hostSocket;
    private DatagramSocket listener;
    private WifiManager.MulticastLock multicastLock;
    private final Map<String, JSONObject> nearby = new ConcurrentHashMap<>();
    private final Map<String, Long> seen = new ConcurrentHashMap<>();
    private java.util.concurrent.ScheduledFuture<?> announcing;

    private static void writeLine(Socket socket, String json) {
        try {
            OutputStream out = socket.getOutputStream();
            synchronized (socket) {
                out.write((json + "\n").getBytes(StandardCharsets.UTF_8));
                out.flush();
            }
        } catch (Exception ignored) { }
    }

    private void participants() {
        JSONArray names = new JSONArray();
        for (String name : guests.values()) names.put(name);
        relay.emit("jam:participants", "[" + names + "]");
    }

    JSONObject jamHost(String name) throws Exception {
        jamStop();
        jamServer = new ServerSocket(0);
        int jamPort = jamServer.getLocalPort();
        ServerSocket server = jamServer;
        pool.execute(() -> {
            try {
                while (!server.isClosed()) {
                    Socket guest = server.accept();
                    guests.put(guest, "Invité");
                    pool.execute(() -> readGuest(guest));
                }
            } catch (Exception ignored) { }
        });
        announcer = new DatagramSocket();
        announcer.setBroadcast(true);
        DatagramSocket udp = announcer;
        byte[] message = new JSONObject().put("app", "nova-jam").put("name", name).put("port", jamPort).toString().getBytes(StandardCharsets.UTF_8);
        announcing = timers.scheduleAtFixedRate(() -> {
            try { udp.send(new DatagramPacket(message, message.length, InetAddress.getByName("255.255.255.255"), JAM_PORT)); } catch (Exception ignored) { }
        }, 0, 2, TimeUnit.SECONDS);
        JSONObject result = new JSONObject();
        result.put("port", jamPort);
        result.put("addresses", new JSONArray(localAddresses()));
        return result;
    }

    private void readGuest(Socket guest) {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(guest.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                try {
                    JSONObject message = new JSONObject(line);
                    if ("hello".equals(message.optString("type"))) {
                        String name = message.optString("name", "Invité");
                        guests.put(guest, name.length() > 40 ? name.substring(0, 40) : name);
                    }
                    relay.emit("jam:fromGuest", "[" + message + "," + JSONObject.quote(guests.getOrDefault(guest, "Invité")) + "]");
                    if ("hello".equals(message.optString("type"))) participants();
                } catch (Exception ignored) { }
            }
        } catch (Exception ignored) {
        } finally {
            String left = guests.remove(guest);
            participants();
            if (left != null) relay.emit("jam:info", "[" + JSONObject.quote(left + " a quitté le Jam") + "]");
        }
    }

    void jamBroadcast(String message) {
        for (Socket guest : guests.keySet()) pool.execute(() -> writeLine(guest, message));
    }

    void jamBrowse() {
        if (listener != null) return;
        try {
            WifiManager wifi = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
            if (wifi != null) {
                multicastLock = wifi.createMulticastLock("nova-jam");
                multicastLock.setReferenceCounted(false);
                multicastLock.acquire();
            }
            DatagramSocket socket = new DatagramSocket(null);
            socket.setReuseAddress(true);
            socket.setBroadcast(true);
            socket.bind(new InetSocketAddress(JAM_PORT));
            listener = socket;
            pool.execute(() -> {
                byte[] buffer = new byte[2048];
                while (!socket.isClosed()) {
                    try {
                        DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                        socket.receive(packet);
                        JSONObject message = new JSONObject(new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8));
                        String address = packet.getAddress().getHostAddress();
                        if (!"nova-jam".equals(message.optString("app"))) continue;
                        if (jamServer != null && localAddresses().contains(address)) continue;
                        String id = address + ":" + message.optInt("port");
                        JSONObject jam = new JSONObject().put("id", id).put("name", message.optString("name", "Jam"))
                                .put("address", address).put("port", message.optInt("port"));
                        nearby.put(id, jam);
                        seen.put(id, System.currentTimeMillis());
                        for (String key : new ArrayList<>(seen.keySet())) {
                            if (System.currentTimeMillis() - seen.get(key) > 8000) { seen.remove(key); nearby.remove(key); }
                        }
                        relay.emit("jam:nearby", "[" + new JSONArray(nearby.values()) + "]");
                    } catch (Exception e) {
                        if (socket.isClosed()) break;
                    }
                }
            });
        } catch (Exception ignored) {
            jamStopBrowsing();
        }
    }

    void jamStopBrowsing() {
        if (listener != null) listener.close();
        listener = null;
        nearby.clear();
        seen.clear();
        if (multicastLock != null && multicastLock.isHeld()) multicastLock.release();
    }

    void jamJoin(String address, int jamPort, String name) throws Exception {
        leaveGuest();
        Socket socket = new Socket();
        socket.connect(new InetSocketAddress(address, jamPort), 10_000);
        hostSocket = socket;
        writeLine(socket, new JSONObject().put("type", "hello").put("name", name).toString());
        pool.execute(() -> {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    try { relay.emit("jam:fromHost", "[" + new JSONObject(line) + "]"); } catch (Exception ignored) { }
                }
            } catch (Exception ignored) {
            } finally {
                if (hostSocket == socket) {
                    hostSocket = null;
                    relay.emit("jam:ended", "[]");
                }
            }
        });
    }

    void jamToHost(String message) {
        Socket socket = hostSocket;
        if (socket != null) pool.execute(() -> writeLine(socket, message));
    }

    private void leaveGuest() {
        Socket socket = hostSocket;
        hostSocket = null;
        if (socket != null) try { socket.close(); } catch (Exception ignored) { }
    }

    void jamStop() {
        if (announcing != null) announcing.cancel(false);
        announcing = null;
        if (announcer != null) announcer.close();
        announcer = null;
        for (Socket guest : guests.keySet()) {
            writeLine(guest, "{\"type\":\"ended\"}");
            try { guest.close(); } catch (Exception ignored) { }
        }
        guests.clear();
        if (jamServer != null) try { jamServer.close(); } catch (Exception ignored) { }
        jamServer = null;
        leaveGuest();
    }
}
