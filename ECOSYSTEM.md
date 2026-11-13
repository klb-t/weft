# Weft w ekosystemie

Stan odczytu: 2026-11-13. Źródło, które uznaję za najnowsze, to prywatne zbiorcze repozytorium `klb-t/ekosystem` (snapshot `46653f34`, tag `snapshot-20261105`). To nie jest historia projektów. Historia i SHA są w `MANIFEST.json`.

Publiczne `klb-t/loom` i `klb-t/chatadhd` są starsze. Aktywne jądro leży w `kernel/loom` (w źródle: `chatadhd/loom` na `claude/integration-1b-stage`, commit `41420934`). Aplikacja czatu, bez drugiej kopii jądra, leży w `apps/chatadhd`.

Przejrzane repozytoria konta `klb-t`: `ekosystem`, `pitchera`, `ecosystem-operations`, `ecosystem-backup`, `AGEDS`, `Watchdog-JH16`, `chatadhd`, `loom`, `Custom-Keyboard-Pro` (iOmatrix), `ar-drafty`, `LEM-Workbench`. Weft dopina się do jądra i do czatu. Pozostałych nie importuje.

## Czego nie robię

Nie dokładam Weft do monolitu. `spec/WSPOLNE_MODULY.md` (2026-11-05): wspólne między projektami w różnych językach są format, kontrakt, wektory i walidator. Implementacja zostaje tutaj. Nie zmieniam `kernel/loom`.

## Apka (ChatADHD) i biblioteka (Loom)

Jedno podpięcie obsługuje obie rzeczy, bo czat woła narzędzia przez Loom.

| Krok | Gdzie w jądrze | Co daje Weft |
|---|---|---|
| Dodać źródło | port `tool_source`, akcja `add`. Ustawienie `tool_sources`, klucz `weft`. Schemat w `include/loom/tool_sources.h`. | [packs/tool_source.weft.json](packs/tool_source.weft.json) |
| Zsynchronizować narzędzia | `sync` pisze overlay `profiles/actions.pack`, id `tool.weft.<narzędzie>`, port `tool_source`, akcja `call:weft:<narzędzie>`. Paczki wysyłanej nie rusza. | Narzędzia ogłasza `mcp/server.mjs` (`tools/list`) |
| Skutki | `entry_of` w `src/tool_sources/tool_sources.cpp`: najpierw `unknown_effects`, potem `effects` źródła, potem `tools.<nazwa>.effects`. Reguła `confirm:tool_source.unknown` pyta, gdy flaga `effects_unknown` jest ustawiona. | Każde narzędzie ma `effects_unknown: false` i uczciwe pozostałe flagi. Logowanie i tak jest `approve` wewnątrz `libweft`. |
| Zaufanie | `trust`, tryb `allow` \| `confirm` \| `reset`, reguła overlayu `tool_source:weft:` albo `tool_source:weft:<narzędzie>`. | Zapas, gdyby dopasowanie reguły się zmieniło. Nie zastępuje bramki logowania. |
| Protokół | `data/runtime/tool_sources.pack`, kind `mcp`, `2025-06-18`, stdio, metody `initialize`, `notifications/initialized`, `tools/list`, `tools/call`. Stderr jest porzucany. Żądania serwera poza `ping` są odrzucane. | Shim mówi tylko JSON-RPC w liniach na stdout. |
| Sesja mimo nowego procesu | Każde wywołanie robi własny `fork` (`mcp.cpp`, „every operation opens its own session”). | Demon trzyma Chrome i `weft serve`. Shim tylko przekazuje `/call`. |
| Identyfikator | `element_resolution.pack`: źródła to zamknięta lista. `projection` nie czyta magazynu. | Dopisać `weft:` / klasa `weft_session`. Fragment: [packs/element_resolution.weft.fragment.json](packs/element_resolution.weft.fragment.json). |
| Sekret | `chat_secrets.pack` i skarbiec. Konfiguracja źródła trzyma `access.secret` i `env.*.secret` jako **nazwy** kluczy, nigdy bajty. | Weft nie potrzebuje sekretu w konfiguracji MCP. Hasło strony idzie `vault_text` z pliku kontrolnego albo dialogu Androida, do `fillTrusted`, i nie wraca w zrzucie. |
| Biblioteka | Loom jest C++20. Port `tool_source` już jest adapterem. | `libweft` (`include/weft/weft.h`) jest tym, co wołałby przyszły port w procesie. Dziś czat nie musi go linkować: wystarcza MCP. Android linkuje tę samą bibliotekę przez JNI. |

Potwierdzenie `tool_source.add` (reguła w `action_rules.pack`) zostaje. To jedna zgoda na dołączenie modułu, nie zgoda na każde kliknięcie.

Graf źródła dopisuje sam Loom przy `sync`: środowisko `environment:service:tool_source:weft`, zdolność, port `port:tool_source`. Weft nie pisze do bazy czatu.

## Kontrakt, który zostaje po tej stronie

Paczka [data/runtime/weft.pack](data/runtime/weft.pack) jest `loom.runtime_profile/1`, domena `weft`. Walidator to `make test` i [contract/vectors.json](contract/vectors.json): szesnaście wektorów polityki plus sesja (agent nie zatwierdza, dziennik nie zawiera sekretu).

Schematy, których jądro nie musi znać, bo zostają w module:

| Schemat | Co to jest |
|---|---|
| `loom.weft.decision/1` | allow, approve, deny, preempt |
| `loom.weft.snapshot/1` | zrzut strony bez wartości sekretów |
| `loom.weft.approval/1` | publiczny widok czekania |
| `loom.weft.receipt/1` | paragon bez treści |
| `loom.weft.session/1` | wynik `submit` / `resolve` |
| `loom.weft.control/1` | port, token, czekanie |
| `loom.weft.journal/1` | lista paragonów |

Decyzje Loom to `allow | confirm | deny`. Weft ma `allow | approve | deny | preempt`. `approve` jest potwierdzeniem **wewnątrz** modułu. Dla katalogu Loom zwykłe działanie ma już znane skutki, więc nie dokłada swojego `confirm`. Osoba i tak widzi logowanie.

## Wspólne moduły (spec, nie kod tamtych projektów)

| Id | Co Weft z tego bierze | Czego nie bierze |
|---|---|---|
| WM-1 | Napisy reguł są `{pl, en}`. | Nie wciągam walidatora pakietów iOmatrix. |
| WM-2 | Sekrety nie wchodzą do stdout narzędzia. Stderr i tak ginie w Loom. | Nie ma wspólnego loggera. |
| WM-3 | Paragon bez treści i bez klucza. | Weft nie woła modelu i nie wydaje pieniędzy. `costs_money` jest false. |
| WM-4 | Nic. Przeglądarka nie jest odkrywaniem formatu. | — |
| WM-5 | Adres w paragonie jest kształtem, nie kopią z query. Oryginał strony zostaje w Chromium. | Nie ma wspólnego magazynu blobów. |

AGEDS i WatchDog mogą kiedyś czytać paragony jako pochodzenie. Nie ma zależności kompilacji. iOmatrix nie jest skarbcem Weft: przyszły port skarbca miałby oddawać tekst do `vault_text`, nie do modelu. Piczer, Face i LEM nie są ruszane.

## Filozofia, której się trzymam

Z `docs/ekosystem` i z opisu paczki `tool_sources`: nic nie jest wołane, dopóki osoba nie doda źródła. Skutek zewnętrznego narzędzia jest nieznany, dopóki osoba (albo jawne flagi w konfiguracji, którą ona zatwierdza przy `add`) nie powie inaczej. Katalog nie dostaje kluczy. Weft nie wysyła sekretu w ładunku działania i nie zapisuje go w dzienniku.

## English

The newest kernel is `klb-t/ekosystem` `kernel/loom` at snapshot `46653f34` (source commit `41420934`), not the older public `loom` and `chatadhd` repositories. Weft attaches through the MCP tool-source port that kernel already ships. It does not patch the kernel. Because each MCP call is a new process, the stdio entry is a shim and Chromium lives in a daemon. `effects_unknown: false` on each tool is what stops a second Loom confirmation; logins still wait inside `libweft`. Shared ecosystem modules stay contracts (WM-3 receipt without content, WM-5 provenance without a shared store). No hard dependency on AGEDS, WatchDog, iOmatrix, Piczer, Face or LEM.
