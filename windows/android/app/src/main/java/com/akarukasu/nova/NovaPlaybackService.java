package com.akarukasu.nova;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.IBinder;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import java.io.InputStream;
import java.net.URL;

/**
 * Service de lecture au premier plan : garde Nova en vie écran éteint, affiche la notification
 * multimédia (titre, pochette, lecture/pause, précédent, suivant) et reçoit les boutons du casque.
 */
public class NovaPlaybackService extends Service {
    public interface Listener { void onAction(String action); }

    static Listener listener;
    private static final String CHANNEL = "nova_playback";
    private static final int ID = 42;
    private static NovaPlaybackService instance;
    private static String title = "Nova", artist = "", artworkUrl = null;
    private static boolean playing = false;
    private static Bitmap artwork;

    private MediaSessionCompat session;

    static void start(Context context) {
        if (instance != null) return;
        ContextCompat.startForegroundService(context, new Intent(context, NovaPlaybackService.class));
    }

    static void update(Context context, String newTitle, String newArtist, String newArtwork, boolean isPlaying) {
        boolean artworkChanged = newArtwork != null && !newArtwork.equals(artworkUrl);
        title = newTitle;
        artist = newArtist;
        playing = isPlaying;
        if (artworkChanged) {
            artworkUrl = newArtwork;
            new Thread(() -> {
                try (InputStream input = new URL(newArtwork).openStream()) {
                    artwork = BitmapFactory.decodeStream(input);
                } catch (Exception e) {
                    artwork = null;
                }
                if (instance != null) instance.refresh();
            }).start();
        }
        if (instance != null) instance.refresh();
        else if (isPlaying) start(context);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Lecture", NotificationManager.IMPORTANCE_LOW);
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }
        session = new MediaSessionCompat(this, "Nova");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { send("play"); }
            @Override public void onPause() { send("pause"); }
            @Override public void onSkipToNext() { send("next"); }
            @Override public void onSkipToPrevious() { send("previous"); }
        });
        session.setActive(true);
        Notification notification = build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        else startForeground(ID, notification);
    }

    private static void send(String action) {
        if (listener != null) listener.onAction(action);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && intent.getAction() != null) send(intent.getAction());
        return START_STICKY;
    }

    private PendingIntent action(String name, int code) {
        Intent intent = new Intent(this, NovaPlaybackService.class).setAction(name);
        return PendingIntent.getService(this, code, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private Notification build() {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_nova)
                .setContentTitle(title)
                .setContentText(artist)
                .setLargeIcon(artwork)
                .setContentIntent(content)
                .setOnlyAlertOnce(true)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOngoing(playing)
                .addAction(android.R.drawable.ic_media_previous, "Précédent", action("previous", 1))
                .addAction(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                        playing ? "Pause" : "Lecture", action(playing ? "pause" : "play", 2))
                .addAction(android.R.drawable.ic_media_next, "Suivant", action("next", 3))
                .setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                        .setMediaSession(session.getSessionToken())
                        .setShowActionsInCompactView(0, 1, 2));
        return builder.build();
    }

    void refresh() {
        MediaMetadataCompat.Builder metadata = new MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist);
        if (artwork != null) metadata.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, artwork);
        session.setMetadata(metadata.build());
        session.setPlaybackState(new PlaybackStateCompat.Builder()
                .setActions(PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE | PlaybackStateCompat.ACTION_PLAY_PAUSE
                        | PlaybackStateCompat.ACTION_SKIP_TO_NEXT | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS)
                .setState(playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                        PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, 1f)
                .build());
        getSystemService(NotificationManager.class).notify(ID, build());
    }

    @Override
    public void onDestroy() {
        instance = null;
        session.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
