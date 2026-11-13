# Weft

Wspólna sesja Chromium. Agent klika razem z Tobą. Logowanie, hasło, karta i zgoda przeglądarki czekają na Ciebie. Sekret nie wchodzi do modelu.

To nie jest fork Chromium. Na Windowsie i Linuksie silnikiem jest zainstalowany Chrome albo Chromium (DevTools). Na Androidzie — systemowy WebView, czyli ten sam Chromium, który ma telefon. Polityka jest jedną biblioteką C++20, `libweft`. Hosty tylko dowożą stronę.

## Co jest wspólne, a co nie

| | Windows | Linux | Android | headless |
|---|---|---|---|---|
| Polityka | `libweft` | to samo | JNI do tego samego | to samo |
| Skrypt strony | [hosts/shared/page_agent.js](hosts/shared/page_agent.js) | to samo | kopia w `assets/` | to samo |
| Silnik | Chrome/Chromium przez CDP | to samo | WebView | `chrome --headless=new` albo headless-shell |
| Zatwierdzenie | plik kontrolny + `tools/approve.mjs` | to samo | dialog w aplikacji | to samo co pulpit, dopóki czat nie podejrzy pliku |

Kod różni się tylko tam, gdzie musi: [hosts/cdp/spawn.mjs](hosts/cdp/spawn.mjs) (ścieżka do Chrome) i drzewo [android/](android/).

## Podpięcie do ChatADHD i Loom

Najnowsze jądro nie jest w publicznych repozytoriach `klb-t/loom` i `klb-t/chatadhd`. Jest w zbiorczym `klb-t/ekosystem`, ścieżka `kernel/loom`, snapshot `46653f34` (źródło `41420934` na `claude/integration-1b-stage`, 2026-11-05). Weft nie łata tego jądra.

Haczykiem, który jądro już ma, jest źródło narzędzi MCP (`kernel/loom/src/tool_sources`, protokół `2025-06-18`). W czacie dodajesz źródło działaniem portu `tool_source` / `add` (raz, z potwierdzeniem). Treść: [packs/tool_source.weft.json](packs/tool_source.weft.json). `args` musi być **bezwzględną** ścieżką do `mcp/server.mjs`, bo Loom odpala proces ze swojego katalogu danych, nie z tego repozytorium. `node` musi być na `PATH`.

`effects_unknown: false` na każdym narzędziu jest tym, co w `entry_of` (`tool_sources.cpp`) gasi regułę `confirm:tool_source.unknown`. Zwykłe kliknięcie nie pyta drugi raz. Logowanie i tak czeka **w środku Weft**. Gdyby jądro kiedyś dopasowywało regułę inaczej, poluzowanie jest działaniem `trust` (`mode: allow`) dla źródła `weft`.

Loom otwiera **nowy** proces przy każdym `tools/list` i `tools/call` (komentarz na górze `mcp.cpp`). Dlatego `mcp/server.mjs` bez flagi jest tylko cienkim wejściem. Przeglądarka i `weft serve` żyją w odłączonym demonie. Kolejne wywołanie modelu podłącza się do tego samego Chromium.

Identyfikator sesji dla grafu: dopisz jeden wpis z [packs/element_resolution.weft.fragment.json](packs/element_resolution.weft.fragment.json) do `id_forms` w overlayu osoby. Nie podmieniaj całego `element_resolution.pack`. `source` zostaje z zamkniętej listy (`projection`).

Szczegóły, WM-1…WM-5 i czego Weft celowo nie dotyka: [ECOSYSTEM.md](ECOSYSTEM.md).

## Pulpit

```
make
make test
WEFT_CHROME=/sciezka/do/chrome node tests/cdp_smoke.mjs
node tests/mcp_smoke.mjs
```

Headless (domyślnie, gdy binarka nie nazywa się `headless-shell`):

```
node mcp/server.mjs
```

Okno, ta sama sesja, ten sam plik:

```
WEFT_HEADED=1 node mcp/server.mjs
```

Zatwierdzenie nie jest narzędziem modelu:

```
node tools/approve.mjs allow
node tools/approve.mjs deny
node tools/approve.mjs allow --vault-text-file ./sekret.txt
```

Plik kontrolny (`loom.weft.control/1`) leży w `WEFT_CONTROL_FILE`, inaczej w `$XDG_RUNTIME_DIR/weft/control.json`, albo `~/.local/share/weft/control.json`, a na Windowsie w `%LOCALAPPDATA%\weft\control.json`. Tryb `0600`. Nagłówek `X-Weft-Token`. Słucha tylko `127.0.0.1`.

`POST /approval` z `{id, decision: allow|deny, vault_text?}`. `POST /gesture`, gdy ruszasz stronę (agent w oknie `preempt_ms` dostaje `preempt`). `GET /pending`.

## Android

Katalog [android/](android/) to aplikacja `dev.klbt.weft` (minSdk 26). WebView działa bez biblioteki natywnej: przeglądasz sam. Działania agenta bez `libweft-jni` są odmową (fail closed). Skrypt strony ma być bajt w bajt tym samym plikiem co na pulpicie (`node tests/same_page_agent.mjs`).

Złożenie natywne wymaga NDK. CMake bierze `src/` i `include/` z tego repozytorium, nie kopię.

## Czego model nie dostaje

- Wartości haseł, kart, OTP, tokenów. Wpisanie sekretu w argument działania to `deny` / `secret_in_payload` i brak wpisu tej wartości w dzienniku.
- Puste pisanie w pole sekretu to `approve`. Tekst podajesz Ty, lokalnie (`vault_text`). Strona sama odmawia `type` / `fill` / `select` na polu sekretu. `fillTrusted` woła tylko host, po Twojej zgodzie.
- Narzędzia modelu: `weft_open`, `weft_snapshot`, `weft_act`, `weft_pending`, `weft_close`. Nie ma `weft_approve`.

Paragon `loom.weft.receipt/1` nie niesie treści ani sekretu. Zostaje kształt adresu bez userinfo, query i fragmentu.

## Model zagrożenia

Bramka zatrzymuje kanał narzędzia modelu. Nie zatrzymuje procesu tego samego użytkownika: kto może czytać plik kontrolny, może zatwierdzić. Na Androidzie zatwierdzenie jest w procesie aplikacji, nie w tym pliku.

## Granice, świadomie

- Nie obsługuje iframe z innej domeny ani OOPIF.
- `javascript:` i adres z userinfo są odrzucane.
- Headless-shell nie ma okna. Okno to Twoja instalacja Chrome (`WEFT_HEADED=1`).
- Czas zatwierdzenia w paczce to 90 s, bo limit jednego wywołania MCP w jądrze to 120 s (`tool_sources.pack`, `kinds.mcp.timeout_ms`). Dłuższe czekanie wymaga podniesienia tego limitu w overlayu `profiles/tool_sources.pack`.

## Licencja

PolyForm Noncommercial 1.0.0. Copyright 2026 klb-t. Użycie komercyjne: osobna licencja, [COMMERCIAL_LICENSE.md](COMMERCIAL_LICENSE.md). Tak samo jak Loom.

## English

Weft is a shared Chromium session. The agent may click. A login, a password, a card or a browser permission waits for the person. Secrets are not sent to the model.

It is not a Chromium fork. Desktop uses the installed Chrome via CDP. Android uses the system WebView. Policy is one C++20 library. Attach it to ChatADHD through Loom's existing MCP tool source (`packs/tool_source.weft.json`); do not patch the kernel. The public `loom` and `chatadhd` repositories are older than `ekosystem` `kernel/loom`. Loom starts a new MCP process per call, so the browser is a detached daemon and the stdio program is a shim. See [ECOSYSTEM.md](ECOSYSTEM.md).
