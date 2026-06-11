#!/usr/bin/env python3
import argparse
import os

from ds_store import DSStore, DSStoreEntry
from ds_store.store import ILocCodec, PlistCodec
from mac_alias import Bookmark


def parse_pair(value):
    left, right = value.split(",", 1)
    return int(left), int(right)


def main():
    parser = argparse.ArgumentParser(description="Write Finder layout metadata for Mia DMGs.")
    parser.add_argument("--volume", required=True)
    parser.add_argument("--background", required=True)
    parser.add_argument("--window-origin", required=True)
    parser.add_argument("--window-size", required=True)
    parser.add_argument("--app-position", required=True)
    parser.add_argument("--applications-position", required=True)
    parser.add_argument("--icon-size", type=int, default=96)
    parser.add_argument("--text-size", type=int, default=14)
    parser.add_argument("--app-name", default="Mia.app")
    args = parser.parse_args()

    window_x, window_y = parse_pair(args.window_origin)
    window_w, window_h = parse_pair(args.window_size)
    app_x, app_y = parse_pair(args.app_position)
    applications_x, applications_y = parse_pair(args.applications_position)
    background_path = os.path.abspath(args.background)
    store_path = os.path.join(args.volume, ".DS_Store")

    background_bookmark = Bookmark.for_file(background_path).to_bytes()
    entries = [
        DSStoreEntry(".", b"bwsp", PlistCodec, {
            "ContainerShowSidebar": False,
            "ShowPathbar": False,
            "ShowSidebar": False,
            "ShowStatusBar": False,
            "ShowTabView": False,
            "ShowToolbar": False,
            "SidebarWidth": 0,
            "WindowBounds": f"{{{{{window_x}, {window_y}}}, {{{window_w}, {window_h}}}}}"
        }),
        DSStoreEntry(".", b"icvp", PlistCodec, {
            "arrangeBy": "none",
            "backgroundType": 2,
            "backgroundImageAlias": background_bookmark,
            "gridOffsetX": 0.0,
            "gridOffsetY": 0.0,
            "gridSpacing": 100.0,
            "iconSize": float(args.icon_size),
            "labelOnBottom": True,
            "showIconPreview": True,
            "showItemInfo": False,
            "textSize": float(args.text_size),
            "viewOptionsVersion": 1
        }),
        DSStoreEntry(args.app_name, b"Iloc", ILocCodec, (app_x, app_y)),
        DSStoreEntry("Applications", b"Iloc", ILocCodec, (applications_x, applications_y)),
        DSStoreEntry(".", b"vSrn", "long", 1),
    ]

    with DSStore.open(store_path, "w+", initial_entries=entries) as store:
        store.flush()


if __name__ == "__main__":
    main()
