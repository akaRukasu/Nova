#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use gpui::{
    App, Application, Bounds, Context, TitlebarOptions, Window, WindowBounds, WindowOptions,
    div, prelude::*, px, rgb, size, uniform_list,
};

const ROW_COUNT: usize = 10_000;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Catalog {
    Members,
    Emoji,
    Sounds,
}

impl Catalog {
    fn labels(self) -> (&'static str, &'static str) {
        match self {
            Self::Members => ("Membres", "Membre"),
            Self::Emoji => ("Émojis", "Émoji"),
            Self::Sounds => ("Soundboard", "Son"),
        }
    }
}

struct Preview {
    catalog: Catalog,
    smoke_marker: Option<std::path::PathBuf>,
}

impl Render for Preview {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(path) = self.smoke_marker.take() {
            std::fs::write(path, "GPUI reached the first render").expect("write smoke marker");
        }
        let active = self.catalog;
        let tabs = div().flex().gap_2().children(
            [Catalog::Members, Catalog::Emoji, Catalog::Sounds]
                .into_iter()
                .enumerate()
                .map(|(index, catalog)| {
                    div()
                        .id(index)
                        .cursor_pointer()
                        .px_3()
                        .py_2()
                        .rounded_md()
                        .bg(rgb(if catalog == active { 0x4d47a9 } else { 0x272837 }))
                        .child(catalog.labels().0)
                        .on_click(cx.listener(move |view, _, _, cx| {
                            view.catalog = catalog;
                            cx.notify();
                        }))
                }),
        );

        let rows = uniform_list(active.labels().0, ROW_COUNT, move |range, _, _| {
            range.map(|index| {
                let badge = match active {
                    Catalog::Members => "●",
                    Catalog::Emoji => ["✨", "🎮", "🎵", "🌙"][index % 4],
                    Catalog::Sounds => "♪",
                };
                div()
                    .h(px(42.0))
                    .flex()
                    .items_center()
                    .gap_3()
                    .px_3()
                    .bg(rgb(if index % 2 == 0 { 0x20212d } else { 0x232532 }))
                    .child(div().w(px(26.0)).text_color(rgb(0xaaa4ff)).child(badge))
                    .child(format!("{} {:05}", active.labels().1, index + 1))
            }).collect::<Vec<_>>()
        })
        .size_full();

        div()
            .size_full()
            .flex()
            .flex_col()
            .gap_4()
            .p_5()
            .bg(rgb(0x151620))
            .text_color(rgb(0xf1efff))
            .child(div().text_xl().child("Nacre"))
            .child(div().text_sm().text_color(rgb(0xb1b3cc))
                .child("Prototype GPUI · 10 000 entrées fictives par liste · aucune connexion Discord"))
            .child(tabs)
            .child(div().flex_1().min_h_0().overflow_hidden().rounded_md().child(rows))
    }
}

fn main() {
    let smoke_marker = std::env::var_os("NACRE_SMOKE").map(std::path::PathBuf::from);
    if let Some(path) = &smoke_marker {
        let panic_log = path.with_extension("panic");
        std::panic::set_hook(Box::new(move |info| {
            let _ = std::fs::write(&panic_log, info.to_string());
        }));
    }
    Application::new().run(move |cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(900.0), px(680.0)), cx);
        cx.open_window(
            WindowOptions {
                show: true,
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some("Nacre · aperçu".into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
            move |_, cx| cx.new(|_| Preview { catalog: Catalog::Members, smoke_marker }),
        )
        .expect("Impossible d’ouvrir la fenêtre GPUI");
        cx.activate(true);
    });
}
