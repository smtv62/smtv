from justsporthd.manager import JustSportHDManager


def main():
    manager = JustSportHDManager()
    content = manager.run()

    if content:
        with open("playlist.m3u", "w", encoding="utf-8") as f:
            f.write(content)
        print("[+] playlist.m3u dosyası oluşturuldu.")
    else:
        print("[-] Playlist oluşturulamadı.")


if __name__ == "__main__":
    main()
