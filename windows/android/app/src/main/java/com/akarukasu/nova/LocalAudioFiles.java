package com.akarukasu.nova;

import android.content.Context;
import android.database.Cursor;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.provider.OpenableColumns;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

final class LocalAudioFiles {
    private final Context context;
    private final File directory;

    LocalAudioFiles(Context context) {
        this.context = context;
        this.directory = new File(context.getFilesDir(), "LocalAudio");
    }

    JSObject importFiles(List<Uri> files) {
        JSArray tracks = new JSArray(), errors = new JSArray();
        for (Uri uri : files) {
            String name = displayName(uri);
            File temporary = null;
            try {
                if (!directory.isDirectory() && !directory.mkdirs()) throw new Exception("Stockage indisponible.");
                String extension = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT) : "";
                if (!extension.matches("[a-z0-9]{1,8}")) throw new Exception("Extension audio non reconnue.");
                temporary = new File(directory, UUID.randomUUID() + ".tmp");
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                try (InputStream input = context.getContentResolver().openInputStream(uri);
                     FileOutputStream output = new FileOutputStream(temporary)) {
                    if (input == null) throw new Exception("Fichier inaccessible.");
                    byte[] buffer = new byte[65536];
                    int read;
                    while ((read = input.read(buffer)) != -1) {
                        digest.update(buffer, 0, read);
                        output.write(buffer, 0, read);
                    }
                }
                StringBuilder hash = new StringBuilder();
                for (byte value : digest.digest()) hash.append(String.format(Locale.ROOT, "%02x", value & 0xff));
                String key = hash.toString();
                JSObject track = new JSObject();
                MediaMetadataRetriever metadata = new MediaMetadataRetriever();
                try {
                    metadata.setDataSource(temporary.getAbsolutePath());
                    if (!"yes".equals(metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO))) {
                        throw new Exception("Format audio non pris en charge par cet appareil.");
                    }
                    String title = metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE);
                    String artist = metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST);
                    track.put("title", title == null || title.isEmpty() ? name.substring(0, name.lastIndexOf('.')) : title);
                    track.put("artist", artist == null || artist.isEmpty() ? "Artiste inconnu" : artist);
                    String album = metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM);
                    if (album != null) track.put("album", album);
                    String duration = metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
                    if (duration != null) track.put("duration", Double.parseDouble(duration) / 1000);
                    byte[] picture = metadata.getEmbeddedPicture();
                    if (picture != null && picture.length <= 10000000) {
                        File cover = new File(directory, key + ".cover.jpg");
                        try (FileOutputStream output = new FileOutputStream(cover)) { output.write(picture); }
                        track.put("artwork", Uri.fromFile(cover).toString());
                    }
                } finally { metadata.release(); }
                File destination = new File(directory, key + "." + extension);
                if (destination.exists()) {
                    if (!temporary.delete()) throw new Exception("Nettoyage du fichier temporaire impossible.");
                } else if (!temporary.renameTo(destination)) throw new Exception("Copie du fichier impossible.");
                temporary = null;
                track.put("id", "local:" + key);
                track.put("localFileName", destination.getName());
                track.put("square", true);
                tracks.put(track);
            } catch (Exception error) {
                errors.put(name + " — " + error.getMessage());
            } finally {
                if (temporary != null) temporary.delete();
            }
        }
        JSObject result = new JSObject();
        result.put("tracks", tracks);
        result.put("errors", errors);
        return result;
    }

    String url(String id) throws Exception {
        if (id == null || !id.matches("local:[a-f0-9]{64}")) throw new Exception("Identifiant local invalide.");
        String prefix = id.substring(6) + ".";
        File[] matches = directory.listFiles(file -> file.isFile() && file.getName().startsWith(prefix)
                && !file.getName().contains(".cover.") && !file.getName().endsWith(".tmp"));
        if (matches == null || matches.length == 0) throw new Exception("Ce fichier audio est absent de cet appareil.");
        return Uri.fromFile(matches[0]).toString();
    }

    private String displayName(Uri uri) {
        try (Cursor cursor = context.getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) return cursor.getString(0);
        } catch (Exception ignored) {}
        return "audio";
    }
}

