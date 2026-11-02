// SPDX-License-Identifier: GPL-3.0-or-later
// AudioInput hook adapted from YashRajCodes/soundboardPermissionsBypass.web (GPL-3.0-or-later).
import definePlugin from "@utils/types";

export default definePlugin({
    name: "NovaCordMedia",
    description: "Use the chosen screenshare profile instead of fixed 4K/120 limits.",
    authors: [],
    required: true,
    patches: [{
        // Mix in Discord's AudioInput context, before its voice processing and transmission gate.
        find: "AudioInput: No MediaStream",
        replacement: [{
            match: /(?<=}else this\.stream=\i;)return this\.updateMode\(\)/,
            replace: "this.stream=window.NovaCordAudio.attachInput(this,this.stream);return this.updateMode()"
        }, {
            match: /release\((\i)\)\{\1\.getTracks\(\)/,
            replace: "release($1){window.NovaCordAudio.releaseInput($1);$1.getTracks()"
        }]
    }],
    start() {
        const picker = Vencord.Plugins.plugins.WebScreenShare;
        if (picker) picker.getGoliveMaxQuality = (options: any) => {
            try {
                return (window as any).NovaCordMedia.configureStreamOptions(options);
            } catch (error) {
                console.error("NovaCord : profil de partage indisponible", error);
                return options;
            }
        };
    }
});
