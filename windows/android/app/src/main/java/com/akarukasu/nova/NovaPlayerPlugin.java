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
import android.os.Handler;
import android.os.Looper;
import android.os.Build;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceError;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

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
import java.util.Collections;

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
    private static final String OCTAVE = "https://music.octavestreaming.com";
    private WebView octave;
    private PluginCall octaveNavigation;
    private boolean octavePanel;
    static NovaPlayerPlugin instance;
    /** Réseau local : synchronisation et télécommande depuis l'iPhone, Jam. */
    private NovaLink link;

    // Rythme des transitions (AutoMix) : Android ne ralentit pas ce minuteur, même écran verrouillé.
    private final Handler tickHandler = new Handler(Looper.getMainLooper());
    private volatile boolean ticking = false;
    private int tickInterval = 25;
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (!ticking) return;
            notifyListeners("tick", new JSObject());
            tickHandler.postDelayed(this, tickInterval);
        }
    };

    @PluginMethod
    public void startTicker(PluginCall call) {
        tickInterval = Math.max(10, call.getInt("interval", 25));
        if (!ticking) {
            ticking = true;
            tickHandler.post(tick);
        }
        call.resolve();
    }

    @PluginMethod
    public void stopTicker(PluginCall call) {
        ticking = false;
        tickHandler.removeCallbacks(tick);
        call.resolve();
    }

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
        NovaPlaybackService.listener = (action, seconds) -> {
            JSObject data = new JSObject();
            data.put("action", action);
            data.put("seconds", seconds);
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

    private static boolean octaveOrigin(Uri uri) {
        return "https".equals(uri.getScheme()) && uri.getUserInfo() == null
                && (uri.getPort() == -1 || uri.getPort() == 443) && "music.octavestreaming.com".equals(uri.getHost());
    }

    @SuppressLint("SetJavaScriptEnabled")
    private WebView octaveView() {
        if (octave != null) return octave;
        WebView view = new WebView(getContext());
        view.getSettings().setJavaScriptEnabled(true);
        view.getSettings().setDomStorageEnabled(true);
        view.getSettings().setMediaPlaybackRequiresUserGesture(false);
        view.getSettings().setUseWideViewPort(true);
        String script = readAsset("nova-octave.js");
        boolean documentStart = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT);
        if (documentStart) WebViewCompat.addDocumentStartJavaScript(view, script, Collections.singleton(OCTAVE));
        view.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView web, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                Uri uri = request.getUrl();
                return !octaveOrigin(uri) && !(octavePanel && "https".equals(uri.getScheme())
                        && ("discord.com".equals(uri.getHost()) || "api.octavestreaming.com".equals(uri.getHost())));
            }

            @Override public void onPageFinished(WebView page, String address) {
                if (octaveOrigin(Uri.parse(address))) {
                    if (!documentStart) page.evaluateJavascript(script, null);
                    if ("ok".equals(Uri.parse(address).getQueryParameter("discord"))) notifyListeners("octaveConnected", new JSObject());
                }
                if (octaveNavigation != null && address.equals(octaveNavigation.getString("url"))) {
                    octaveNavigation.resolve();
                    octaveNavigation = null;
                }
            }

            @Override public void onReceivedError(WebView page, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame() && octaveNavigation != null
                        && request.getUrl().toString().equals(octaveNavigation.getString("url"))) {
                    octaveNavigation.reject("Impossible de charger Octave.");
                    octaveNavigation = null;
                }
            }
        });
        octave = view;
        attachOctaveInBackground();
        return view;
    }

    private void attachOctaveInBackground() {
        ViewGroup parent = (ViewGroup) octave.getParent();
        if (parent != null) parent.removeView(octave);
        octave.setAlpha(0f);
        octave.setFocusable(false);
        octave.setImportantForAccessibility(WebView.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        ViewGroup root = getActivity().findViewById(android.R.id.content);
        float density = root.getResources().getDisplayMetrics().density;
        root.addView(octave, 0, new FrameLayout.LayoutParams((int) (1280 * density), (int) (780 * density)));
    }

    @PluginMethod public void octaveNavigate(PluginCall call) {
        String url = call.getString("url", "");
        if (!octaveOrigin(Uri.parse(url))) { call.reject("Adresse Octave invalide."); return; }
        getActivity().runOnUiThread(() -> {
            WebView view = octaveView();
            if (octaveNavigation == null && url.equals(view.getUrl())) { call.resolve(); return; }
            if (octaveNavigation != null) octaveNavigation.reject("Chargement Octave remplacé.");
            octaveNavigation = call;
            view.loadUrl(url);
            tickHandler.postDelayed(() -> {
                if (octaveNavigation == call) {
                    octaveNavigation = null;
                    call.reject("Le chargement Octave a expiré.");
                }
            }, 12000);
        });
    }

    @PluginMethod public void octaveCall(PluginCall call) {
        String operation = call.getString("operation", "");
        JSObject args = call.getObject("args", new JSObject());
        getActivity().runOnUiThread(() -> {
            if (octave == null || octave.getUrl() == null || !octaveOrigin(Uri.parse(octave.getUrl()))) {
                call.resolve(new JSObject().put("value", "null"));
                return;
            }
            octave.evaluateJavascript("window.novaOctave?.(" + JSONObject.quote(operation) + "," + args + ") ?? null",
                    result -> call.resolve(new JSObject().put("value", result)));
        });
    }

    @PluginMethod public void octavePanel(PluginCall call) {
        boolean visible = Boolean.TRUE.equals(call.getBoolean("visible", false));
        getActivity().runOnUiThread(() -> {
            if (!visible && octavePanel) dismissOverlay();
            if (visible && !octavePanel) {
                if (overlay != null) dismissOverlay();
                WebView view = octaveView();
                ViewGroup parent = (ViewGroup) view.getParent();
                if (parent != null) parent.removeView(view);
                view.setAlpha(1f);
                view.setFocusable(true);
                view.setImportantForAccessibility(WebView.IMPORTANT_FOR_ACCESSIBILITY_AUTO);
                octavePanel = true;
                presentOverlay(view, "Octave", () -> {
                    octavePanel = false;
                    attachOctaveInBackground();
                });
            }
            call.resolve();
        });
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
    public void exchangeHistory(PluginCall call) {
        link.exchangeHistory(call.getString("host"), call.getInt("port", 0), call.getString("token"), call.getString("history"),
                (history, error) -> {
                    if (error != null) call.reject(error);
                    else call.resolve(new JSObject().put("history", history));
                });
    }

    @PluginMethod
    public void unpair(PluginCall call) {
        link.unpair();
        call.resolve();
    }

    @PluginMethod
    public void setRemoteState(PluginCall call) {
        String state = call.getString("state", null);
        link.setRemoteState(state);
        if (state != null) {
            try {
                JSONObject value = new JSONObject(state);
                getActivity().runOnUiThread(() -> NovaPlaybackService.timeline(value.optDouble("time", 0), value.optDouble("duration", 0)));
            } catch (Exception ignored) { }
        }
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
