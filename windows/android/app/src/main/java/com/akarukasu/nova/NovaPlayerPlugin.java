package com.akarukasu.nova;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.UiModeManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * Lecture par le lecteur officiel de YouTube Music, chargé dans des WebView invisibles avec le compte
 * Google de l'utilisateur ; Nova le pilote (titre, lecture/pause, position, volume). Deux lecteurs
 * permettent les transitions AutoMix. Notification multimédia et lecture en arrière-plan via
 * NovaPlaybackService.
 */
@CapacitorPlugin(name = "NovaPlayer")
public class NovaPlayerPlugin extends Plugin {
    private final Map<Integer, WebView> decks = new HashMap<>();
    private final Map<Integer, String> expected = new HashMap<>();
    private final Map<Integer, Double> volumes = new HashMap<>();
    private String controlScript = "";
    private FrameLayout overlay;
    private Runnable overlayClose;
    private PluginCall loginCall;
    static NovaPlayerPlugin instance;
    /** Réseau local : synchronisation et télécommande depuis l'iPhone, Jam. */
    private NovaLink link;

    /** Bouton Retour : ferme la fenêtre YouTube ouverte (connexion, publicité, page), si elle l'est. */
    boolean dismissOverlay() {
        if (overlay == null) return false;
        Runnable close = overlayClose;
        hideOverlay();
        if (close != null) close.run();
        return true;
    }

    @Override
    public void load() {
        instance = this;
        controlScript = readAsset("nova-ytm.js");
        link = new NovaLink(getContext(), (channel, args) -> {
            JSObject data = new JSObject();
            data.put("channel", channel);
            data.put("args", args);
            notifyListeners("relay", data);
        });
        link.start();
        CookieManager.getInstance().setAcceptCookie(true);
        NovaPlaybackService.listener = action -> {
            JSObject data = new JSObject();
            data.put("action", action);
            notifyListeners("media", data);
        };
        // Android 13+ : autorisation des notifications (commandes de lecture).
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(getActivity(), new String[] { Manifest.permission.POST_NOTIFICATIONS }, 7);
        }
    }

    private String readAsset(String name) {
        try (InputStream input = getContext().getAssets().open(name)) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) > 0) output.write(buffer, 0, read);
            return output.toString(StandardCharsets.UTF_8.name());
        } catch (Exception e) {
            return "";
        }
    }

    /** Navigateur ordinaire (sans la mention « wv » des WebView). */
    private static String browserAgent(WebView view) {
        return view.getSettings().getUserAgentString().replace("; wv", "").replaceAll(" Version/\\S+", "");
    }

    @SuppressLint({ "SetJavaScriptEnabled", "AddJavascriptInterface" })
    private WebView deck(int number) {
        WebView existing = decks.get(number);
        if (existing != null) return existing;
        WebView view = new WebView(getContext());
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setUserAgentString(browserAgent(view));
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, true);
        view.addJavascriptInterface(new Bridge(number), "NovaBridge");
        view.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView page, String url) {
                inject(number);
                // Page de consentement aux cookies (Europe) : montrée une fois, l'utilisateur choisit.
                if (url.contains("consent.youtube.com") || url.contains("consent.google.com")) showDeck(number, "YouTube : choisis tes préférences de cookies");
                else if (url.startsWith("https://music.youtube.com") && overlay != null && overlay.getTag() == view) dismissOverlay();
            }
        });
        // Invisible mais vivante : elle continue de jouer quand l'écran est éteint.
        view.setAlpha(0f);
        view.setFocusable(false);
        ViewGroup root = getActivity().findViewById(android.R.id.content);
        root.addView(view, new FrameLayout.LayoutParams(2, 2));
        decks.put(number, view);
        return view;
    }

    private void inject(int number) {
        WebView view = decks.get(number);
        if (view == null) return;
        String id = expected.containsKey(number) ? expected.get(number) : "";
        Double volume = volumes.containsKey(number) ? volumes.get(number) : 0.8;
        view.evaluateJavascript(controlScript + "\nwindow.__nova && window.__nova.expect(" + JSONObject.quote(id) + ", " + volume + ");", null);
    }

    private class Bridge {
        private final int number;
        Bridge(int number) { this.number = number; }

        @JavascriptInterface
        public void post(String json) {
            try {
                JSObject data = new JSObject();
                data.put("deck", number);
                data.put("payload", new JSObject(json));
                notifyListeners("event", data);
            } catch (Exception ignored) { }
        }
    }

    @PluginMethod
    public void load(PluginCall call) {
        int number = call.getInt("deck", 0);
        String id = call.getString("videoId", "");
        double startAt = call.getDouble("startAt", 0.0);
        double volume = call.getDouble("volume", 0.8);
        getActivity().runOnUiThread(() -> {
            expected.put(number, id);
            volumes.put(number, volume);
            String time = startAt > 1 ? "&t=" + (int) startAt : "";
            deck(number).loadUrl("https://music.youtube.com/watch?v=" + Uri.encode(id) + time);
            NovaPlaybackService.start(getContext());
            call.resolve();
        });
    }

    @PluginMethod
    public void command(PluginCall call) {
        int number = call.getInt("deck", 0);
        JSObject command = call.getObject("command", new JSObject());
        if ("volume".equals(command.getString("type"))) volumes.put(number, command.optDouble("value", 0.8));
        getActivity().runOnUiThread(() -> {
            WebView view = decks.get(number);
            if (view != null) view.evaluateJavascript("window.__nova && window.__nova.command(" + command.toString() + ");", null);
            call.resolve();
        });
    }

    /** Titre, artiste, état : notification multimédia et écran verrouillé. */
    @PluginMethod
    public void setMediaInfo(PluginCall call) {
        NovaPlaybackService.update(getContext(), call.getString("title", "Nova"), call.getString("artist", ""),
                call.getString("artwork", null), call.getBoolean("playing", false));
        call.resolve();
    }

    @PluginMethod
    public void showDeck(PluginCall call) {
        int number = call.getInt("deck", 0);
        getActivity().runOnUiThread(() -> { showDeck(number, "YouTube Music"); call.resolve(); });
    }

    private void showDeck(int number, String title) {
        WebView view = decks.get(number);
        if (view == null) return;
        ViewGroup parent = (ViewGroup) view.getParent();
        if (parent != null) parent.removeView(view);
        view.setAlpha(1f);
        view.setFocusable(true);
        presentOverlay(view, title, () -> {
            // Retour à l'état invisible, toujours en lecture.
            ViewGroup holder = (ViewGroup) view.getParent();
            if (holder != null) holder.removeView(view);
            view.setAlpha(0f);
            view.setFocusable(false);
            ViewGroup root = getActivity().findViewById(android.R.id.content);
            root.addView(view, new FrameLayout.LayoutParams(2, 2));
        });
    }

    // MARK: Fenêtre plein écran (connexion Google, pages YouTube Music)

    private void presentOverlay(WebView view, String title, Runnable onClose) {
        hideOverlay();
        Context context = getContext();
        FrameLayout frame = new FrameLayout(context);
        frame.setBackgroundColor(Color.parseColor("#1c1c1e"));
        frame.setTag(view);
        LinearLayout column = new LinearLayout(context);
        column.setOrientation(LinearLayout.VERTICAL);
        LinearLayout bar = new LinearLayout(context);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(24, 48, 24, 16);
        TextView label = new TextView(context);
        label.setText(title);
        label.setTextColor(Color.WHITE);
        label.setTextSize(16);
        bar.addView(label, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        Button close = new Button(context);
        close.setText("Fermer");
        close.setOnClickListener(v -> dismissOverlay());
        bar.addView(close);
        column.addView(bar);
        column.addView(view, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        frame.addView(column);
        overlay = frame;
        overlayClose = onClose;
        ViewGroup root = getActivity().findViewById(android.R.id.content);
        root.addView(frame, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        close.requestFocus();
    }

    private void hideOverlay() {
        if (overlay == null) return;
        ViewGroup root = (ViewGroup) overlay.getParent();
        if (root != null) root.removeView(overlay);
        overlay = null;
        overlayClose = null;
    }

    @SuppressLint("SetJavaScriptEnabled")
    private WebView pageView() {
        WebView view = new WebView(getContext());
        view.getSettings().setJavaScriptEnabled(true);
        view.getSettings().setDomStorageEnabled(true);
        view.getSettings().setUserAgentString(browserAgent(view));
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, true);
        return view;
    }

    /** Connexion au compte Google ; renvoie les cookies de YouTube une fois sur music.youtube.com. */
    @PluginMethod
    public void login(PluginCall call) {
        loginCall = call;
        getActivity().runOnUiThread(() -> {
            WebView view = pageView();
            view.setWebViewClient(new WebViewClient() {
                @Override
                public void onPageFinished(WebView page, String url) {
                    if (!url.startsWith("https://music.youtube.com")) return;
                    String cookies = CookieManager.getInstance().getCookie("https://music.youtube.com");
                    if (cookies != null && (cookies.contains("SAPISID") || cookies.contains("__Secure-3PAPISID")) && loginCall != null) {
                        CookieManager.getInstance().flush();
                        JSObject result = new JSObject();
                        result.put("cookie", cookies);
                        loginCall.resolve(result);
                        loginCall = null;
                        dismissOverlay();
                    }
                }
            });
            presentOverlay(view, "Se connecter à YouTube", () -> {
                if (loginCall != null) { loginCall.resolve(new JSObject()); loginCall = null; }
            });
            view.loadUrl("https://accounts.google.com/ServiceLogin?service=youtube&continue=" + Uri.encode("https://music.youtube.com/"));
        });
    }

    @PluginMethod
    public void logout(PluginCall call) {
        CookieManager.getInstance().removeAllCookies(done -> call.resolve());
    }

    /** Page YouTube Music avec le compte (« Collaborer », invitation à une playlist partagée). */
    @PluginMethod
    public void openPage(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.startsWith("https://music.youtube.com/") && !url.startsWith("https://www.youtube.com/")) { call.reject("Adresse refusée"); return; }
        getActivity().runOnUiThread(() -> {
            WebView view = pageView();
            view.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView page, WebResourceRequest request) { return false; }
            });
            presentOverlay(view, "YouTube Music", null);
            view.loadUrl(url);
            call.resolve();
        });
    }

    @PluginMethod
    public void openExternal(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(call.getString("url", "")));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try { getContext().startActivity(intent); } catch (Exception ignored) { }
        call.resolve();
    }

    // MARK: Réseau local (iPhone, Jam)

    @PluginMethod
    public void syncInfo(PluginCall call) {
        try { call.resolve(JSObject.fromJSONObject(link.info())); } catch (Exception e) { call.reject(e.getMessage()); }
    }

    @PluginMethod
    public void unpair(PluginCall call) {
        link.unpair();
        call.resolve();
    }

    @PluginMethod
    public void setRemoteState(PluginCall call) {
        link.setRemoteState(call.getString("state", null));
        call.resolve();
    }

    @PluginMethod
    public void jamHost(PluginCall call) {
        try { call.resolve(JSObject.fromJSONObject(link.jamHost(call.getString("name", "Nova")))); } catch (Exception e) { call.reject(e.getMessage()); }
    }

    @PluginMethod
    public void jamBroadcast(PluginCall call) {
        link.jamBroadcast(call.getString("message", "{}"));
        call.resolve();
    }

    @PluginMethod
    public void jamBrowse(PluginCall call) {
        link.jamBrowse();
        call.resolve();
    }

    @PluginMethod
    public void jamStopBrowsing(PluginCall call) {
        link.jamStopBrowsing();
        call.resolve();
    }

    @PluginMethod
    public void jamJoin(PluginCall call) {
        try {
            link.jamJoin(call.getString("address", ""), call.getInt("port", 0), call.getString("name", "Invité"));
            call.resolve();
        } catch (Exception e) {
            call.reject("Le Jam ne répond pas.");
        }
    }

    @PluginMethod
    public void jamToHost(PluginCall call) {
        link.jamToHost(call.getString("message", "{}"));
        call.resolve();
    }

    @PluginMethod
    public void jamStop(PluginCall call) {
        link.jamStop();
        call.resolve();
    }

    /** Android TV (télécommande, écran de salon). */
    @PluginMethod
    public void isTV(PluginCall call) {
        UiModeManager manager = (UiModeManager) getContext().getSystemService(Context.UI_MODE_SERVICE);
        JSObject result = new JSObject();
        result.put("tv", manager != null && manager.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION);
        call.resolve(result);
    }

}
