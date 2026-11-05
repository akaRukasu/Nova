package com.akarukasu.nova;

import android.os.Bundle;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NovaPlayerPlugin.class);
        super.onCreate(savedInstanceState);

        // Bouton Retour : Nova ferme d'abord le lecteur plein écran, le menu ou revient à la page précédente ;
        // sinon l'app passe en arrière-plan sans s'arrêter (la musique continue).
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (NovaPlayerPlugin.instance != null && NovaPlayerPlugin.instance.dismissOverlay()) return;
                if (bridge == null || bridge.getWebView() == null) {
                    moveTaskToBack(true);
                    return;
                }
                bridge.getWebView().evaluateJavascript("!!(window.__novaBack && window.__novaBack())", (handled) -> {
                    if (!"true".equals(handled)) moveTaskToBack(true);
                });
            }
        });
    }
}
