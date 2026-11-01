# dsh-speech-to-text-ru

**Локальное распознавание русской речи для голосового ввода в [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**
Добавляет второй, полностью офлайновый распознаватель — **GigaAM-v3 e2e CTC int8** — рядом со
штатным SenseVoice, который понимает только китайский, английский, кантонский, японский и
корейский. Звук не покидает компьютер.

[![CI](https://github.com/almaziphone/dsh-speech-to-text-ru/actions/workflows/ci.yml/badge.svg)](https://github.com/almaziphone/dsh-speech-to-text-ru/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-%E2%89%A50.2.1--rc.5-4b6cf0)](https://github.com/deepseek-ai/deepseek-harness)
[![English README](https://img.shields.io/badge/README-English-blue)](README.md)

## Зачем

Штатный плагин **Voice input** в DSH транскрибирует через SenseVoiceSmall, который не знает
русский. Этот бандл регистрирует ещё одного провайдера `speechToText` на базе GigaAM-v3
(русская ASR-модель от Sber, MIT) через нативный рантайм `sherpa-onnx`, который уже встроен в
DSH. Без облака, API-ключей, Python и отдельных сервисов.

## Что внутри

| | |
|---|---|
| Модель | GigaAM-v3 **e2e** CTC INT8 (пунктуация, заглавные буквы и нормализация чисел — уже в модели) |
| Качество | **3.0 % WER** на контрольном наборе, **0 лексических ошибок** (отличия — только запись чисел) |
| Скорость | **RTF 0.017** на 2 потоках — фраза 8.4 с распознаётся за **~0.17 с**, загрузка модели ~0.36 с |
| Память | пик ~**564 MiB**; воркер выгружается после `idleTimeoutMs` |
| Скачивание | 319.9 МБ модель + 2 КБ токены + 1.8 МБ Silero VAD, проверка размером и SHA-256 |
| Языки | `ru` (родной), `auto`; мультиязычный Whisper — как fallback-движок (`en` и ещё 99) |
| Приватность | инференс на CPU этой машины; звук никуда не отправляется |
| Платформы | macOS arm64/x64, Linux x64/arm64, Windows x64 — везде, где работает DSH Desktop |

## Требования

- **DSH Desktop ≥ 0.2.1-rc.5** (или CLI/Web-профиль из бандлов `dsh-base` + `dsh-web-app`).
- ~330 МБ на диске под кэш модели и ~0.6 ГБ RAM, пока распознаватель загружен.
- Сеть для первого скачивания модели (Hugging Face, запасное зеркало `hf-mirror.com`).
  Полностью офлайновые машины — см. [Офлайн-установка](#офлайн-установка).

## Установка

> **Порядок важен.** Сначала включите штатный **Voice input**, потом добавляйте этот бандл.
> DSH применяет патчи бандлов в порядке `dsh.profile.bundles`, и русский бандл должен идти
> *после* voice-input, чтобы стать распознавателем по умолчанию. Скрипт ниже делает это
> автоматически; при ручной установке в обратном порядке просто выберите **GigaAM-v3 · RU (int8)**
> один раз в настройках — DSH запомнит выбор (либо добавьте блок патча, который пишет
> `scripts/install.sh`).

### Одна команда (рекомендуется)

```bash
# одной строкой, без клонирования:
bash -c "$(curl -fsSL https://raw.githubusercontent.com/almaziphone/dsh-speech-to-text-ru/main/scripts/install.sh)" install.sh

# или из клона (`--spec .` — поставить сам клон вместо GitHub):
git clone https://github.com/almaziphone/dsh-speech-to-text-ru
cd dsh-speech-to-text-ru
./scripts/install.sh
```

Скрипт использует CLI `dsh`, поставляемый с DSH Desktop, делает бэкап профиля, включает
**Voice input**, ставит и выбирает бандл (`dsh plugin add` — pnpm подтянет закреплённый
`sherpa-onnx-node@1.13.8` под вашу платформу) и фиксирует `defaultProvider: gigaam-ru`,
`language: ru` в патче профиля — поэтому дальнейшие переключения бандлов не собьют умолчание.

### Вручную

1. В DSH откройте **Plugins** и включите **Voice input** — появятся кнопка микрофона, сервис
   `speechToText` и его настройки.
2. Добавьте бандл (CLI `dsh` на macOS —
   `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`; добавьте в `PATH`
   или вызывайте по полному пути):

   ```bash
   dsh plugin --profile desktop add github:almaziphone/dsh-speech-to-text-ru
   ```

3. Обновите окно (`Cmd+R` / `Ctrl+R`), откройте **Settings → Voice input**: распознаватель
   должен быть **GigaAM-v3 · RU (int8)**, язык — **ru**. Если нет (например, Voice input
   включили после установки бандла) — выберите его один раз, DSH запомнит выбор в профиле.

Другие источники:

```bash
dsh plugin --profile desktop add ./dsh-speech-to-text-ru-0.1.0.tgz   # архив из Releases
dsh plugin --profile desktop add dsh-speech-to-text-ru               # npm, после публикации
dsh plugin --profile desktop add /path/to/cloned/checkout            # локальный клон (link:)
```

## Первый запуск

Модель **не входит** в пакет. При первой подготовке DSH скачивает закреплённые файлы с
Hugging Face (ревизия зафиксирована, размер и SHA-256 проверяются на лету) в
`~/.dsh/speech-to-text/gigaam-ru/`:

```
~/.dsh/speech-to-text/gigaam-ru/models/gigaam-v3/model.onnx         319 869 121 Б
~/.dsh/speech-to-text/gigaam-ru/models/gigaam-v3/tokens.txt               2 006 Б
~/.dsh/speech-to-text/gigaam-ru/models/silero/silero_vad.onnx         1 807 522 Б
```

Нажмите **Download and prepare** в настройках голосового ввода либо просто микрофон: воркер
загрузит модель (~0.4 с), когда кэш будет полным.

### Офлайн-установка

Скопируйте каталог кэша с уже подготовленной машины в тот же путь на целевой (провайдер
перепроверит каждый файл по SHA-256 перед использованием), либо укажите свои пути через
`modelDirectory` / `vadModelPath` в патче профиля. Чтобы вообще запретить публичные загрузки,
задайте `modelOrigin`, например внутреннее зеркало.

## Использование

1. Нажмите микрофон в поле ввода, продиктуйте по-русски, нажмите **Stop**.
2. Текст вставится в черновик сообщения — с пунктуацией, заглавными буквами и нормализованными
   числами (`в 15:30`, `9:00`), готовый к правке или отправке.
3. Распознаватель и язык можно менять в **Settings → Voice input**; выбор хранится в профиле.

## Качество (замеры на контрольном наборе)

| | GigaAM-v3 e2e CTC INT8 (по умолчанию) | Whisper Small INT8 (fallback) |
|---|---|---|
| WER по корпусу | **3.03 %** (0 лексических ошибок) | 13.64 % |
| Точных совпадений | 4 / 5 фраз | 2 / 5 |
| RTF на 2 потоках | **0.017** | 0.257 |
| RTF на 4 потоках | 0.014 | 0.264 |
| Пик RSS | **564 MiB** | 1.40 GiB |
| Загрузка | 0.36 с | 0.61 с |

Контрольные фразы, расшифровки и методика — в [docs/asr-validation.md](docs/asr-validation.md) и
[docs/model-assets.json](docs/model-assets.json).

## Настройка

Строка провайдера в профиле — `speech-to-text-gigaam`. Переопределяйте её в
`~/.dsh/profiles/<profile>/cordis.patch.yml` (пользовательский патч всегда главнее слоя бандла):

```yaml
- id: speech-to-text-gigaam
  config:
    threads: 4              # потоков CPU (по умолчанию 2)
    precision: int8         # int8 (по умолчанию) или fp32 (крупнее, пока не закреплён)
    engine: gigaam-ctc      # gigaam-ctc (по умолчанию) или whisper
    idleTimeoutMs: 300000   # выгрузить воркер после 5 минут тишины
    # modelDirectory: /abs/path/to/models/gigaam-v3
    # vadModelPath: /abs/path/to/silero_vad.onnx
    # modelOrigin: https://hf-mirror.com     # явное зеркало без fallback
```

| Ключ | По умолчанию | Значение |
|---|---|---|
| `providerId` | `gigaam-ru` | Id провайдера в селекторе |
| `engine` | `gigaam-ctc` | `gigaam-ctc` (русский) или `whisper` (мультиязычный fallback) |
| `precision` | `int8` | `int8` / `fp32` (пока закреплены только INT8-ассеты) |
| `threads` | `2` | Потоки нативного инференса (4 дают ~20 % на этом CPU) |
| `dataRoot` | `~/.dsh/speech-to-text/gigaam-ru` | Абсолютный корень кэша моделей |
| `modelDirectory`, `vadModelPath` | – | Готовые абсолютные файлы вместо скачивания |
| `modelOrigin`, `modelOrigins` | Hugging Face + HF-Mirror | Источники загрузки |
| `segmentSeconds` | `30` | Максимальная длительность VAD-сегмента |
| `vadThreshold`, `minSpeechSeconds`, `minSilenceSeconds`, `vadOnsetPaddingSeconds` | `0.5`, `0.25`, `0.5`, `0.4` | Настройка Silero VAD |
| `idleTimeoutMs` | `300000` | Остановить воркер после простоя (`0` — держать) |
| `maxPending`, `inferenceTimeoutMs`, `prepareTimeoutMs` | `4`, `120000`, `3600000` | Очередь и таймауты |

Выбор по умолчанию для сервиса задаётся на строке `speech-to-text`
(`defaultProvider: gigaam-ru`, `language: ru`).

## Движки

- **`gigaam-ctc`** (по умолчанию) — GigaAM-v3 e2e CTC для sherpa-onnx (NeMo-CTC). Русский,
  MIT, лучшее качество и скорость. Английский не предлагается: GigaAM транслитерирует
  английские слова кириллицей и ошибается в написании.
- **`whisper`** — Whisper Small INT8 (99 языков). Медленнее и менее точен на русском, но удобен
  для смешанной русско-английской диктовки. Включите `engine: whisper`, язык выбирайте в
  настройках голоса. (sherpa-onnx принимает только `""` как auto-detect; провайдер сам
  превращает `auto` в `""`.)

## Как это работает

```
Хост-плагин (lib/index.js)                     воркер-процесс (lib/worker.js)
─────────────────────────                      ──────────────────────────────────
проверка кэша при активации (без загрузок)     загрузка sherpa-onnx OfflineRecognizer
prepare(): скачать → проверить → загрузить     загрузка Silero VAD
transcribe(): POST WAV на 127.0.0.1:PORT  ───► декодирование VAD-сегментов
  bearer-токен, один последовательный воркер    → JSON с текстом обратно
таймаут простоя / отмена → завершение
```

- Ассеты **закреплены по ревизии** на Hugging Face, размер и SHA-256 проверяются на лету;
  проверенный файл повторно не качается.
- Нативный `sherpa-onnx-node` берётся из зависимостей пакета (или из бандла приложения как
  fallback) — этот пакет никогда не тащит платформенные бинарники в себе.
- Воркер — дочерний Node-процесс со случайным 32-байтным токеном; loopback-сервер принимает
  только `POST /transcribe` от Хоста. Звук остаётся в памяти.
- Провайдер — обычная запись плагина DSH (`apply/inject`) с состоянием подготовки
  (`check → download → verify → load`), поэтому стандартные карточки прогресса, отмена и
  настройки работают как у штатного провайдера.

## Если что-то не работает

| Симптом | Что делать |
|---|---|
| Нет микрофона в поле ввода | Включите **Plugins → Voice input**; обновите окно (`Cmd+R`). |
| Провайдера нет в селекторе | Проверьте **Plugins** на ошибку загрузки бандла; убедитесь, что Voice input включён (провайдеру нужен сервис `speechToText`) и бандл идёт в профиле после него. |
| Ошибка «Download and prepare» | Проверьте сеть/диск; UI покажет источник и причину. `modelOrigin` может указывать на зеркало. |
| Кэш с другой машины игнорируется | Имена файлов должны совпадать с `runtime/assets.json`; провайдер проверяет имя, размер и SHA-256. |
| Медленно / грузит CPU | Оставьте `threads: 2`, уменьшите `segmentSeconds`; воркер выгружается после `idleTimeoutMs`. |
| Как удалить | `dsh plugin --profile desktop remove dsh-speech-to-text-ru` и выключите **Voice input** (или оставьте для SenseVoice). |

## Приватность

Из сети скачиваются только веса модели с Hugging Face. Записи распознаются на CPU Хоста, в
памяти, локальным процессом и никуда не загружаются. API-ключи не нужны, телеметрии в плагине нет.

## Разработка

```bash
npm install                      # только закреплённый нативный рантайм sherpa
node --test test/smoke.test.mjs  # 15 контрактных/юнит-тестов без модели (CI гоняет их)
npm pack                         # собрать устанавливаемый архив
node scripts/transcribe.mjs --wav samples/16k.wav --model-dir ~/.dsh/speech-to-text/gigaam-ru/models
```

Установка из локального клона для разработки (модуль по `file://`-URL, без установки пакета):

```bash
dsh plugin --profile dev-profile add /path/to/checkout
```

## Благодарности и лицензии

- **GigaAM-v3** — © SaluteDevices / Sber, MIT. ONNX-конвертация для sherpa-onnx —
  [Smirnov75](https://huggingface.co/Smirnov75/GigaAM-v3-sherpa-onnx).
- **sherpa-onnx** — Apache-2.0 (next-gen Kaldi team); Silero VAD — MIT.
- **DeepSeek Harness** — архитектура провайдера (машина состояний подготовки, транспорт воркера,
  VAD-сегментация, контракт плагина) адаптирована из MIT-пакета
  `@deepseek-ai/dsh-experimental-speech-to-text-sensevoice` и документированного контракта
  сервиса `speechToText`.
- Этот бандл: MIT, см. [LICENSE](LICENSE).

---

English documentation: [README.md](README.md)
