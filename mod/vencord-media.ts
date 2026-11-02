// SPDX-License-Identifier: GPL-3.0-or-later
import definePlugin from "@utils/types";

export default definePlugin({
    name: "NovaCordMedia",
    description: "Use the chosen screenshare profile instead of fixed 4K/120 limits.",
    authors: [],
    required: true,
    patches: [],
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
