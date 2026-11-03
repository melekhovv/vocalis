# Источники голосов: проверка и контракт провайдеров

> Историческое исследование по прежней CC0-политике. 3 ноября 2026 владелец явно разрешил единый каталог сторонних источников без CC0-only/обязательного author-consent gate. Действующие правила: [MODEL_POLICY.md](../MODEL_POLICY.md); текущая русская подборка: [RUSSIAN_VOICE_SOURCES.md](RUSSIAN_VOICE_SOURCES.md). Ниже сохранены первоначальные результаты: отсутствие CC0 evidence больше не означает запрет скачивания по правилам Vocalis.

Дата проверки: **2026-11-03, Asia/Sakhalin**. Политика `MODEL_POLICY.md` не изменена.
Исследование выполнялось публичными GET/HEAD-запросами без авторизации, скачивания весов,
аудиозаписей и обращения к пользовательскому хранилищу.

## Результат

**Hugging Face Hub — технически пригодный реальный источник метаданных и файлов.**
Официальный API доступен; получены реальные результаты поиска и метаданные файлов.
Однако среди проверенных кандидатов **не найден готовый голос RVC с одновременно
подтверждёнными CC0 на веса и исходные записи, происхождением датасета и технической
проверкой весов**. Это не утверждение об отсутствии таких моделей во всём интернете.

Набор реальных разрешённых тестовых голосов: **BLOCKED — недостаточно свидетельств прав**.
Техническая проверка инференса этих кандидатов: **NOT RUN**; большие файлы не скачивались.
Синтетические маленькие checkpoint/FAISS-фикстуры пригодны для автоматических тестов
формата и установки, но не являются опубликованным голосом и не доказывают качество RVC.

Не следует превращать непроверенную поисковую выдачу в официальный каталог скачивания.
Пустое состояние одобренных голосов при рабочем провайдере — честный результат проверки,
а не основание подставлять фан-модели или выдумывать evidence URL.

## Hugging Face

Первичные источники:

- [Официальный Hub API](https://huggingface.co/docs/hub/en/api) и [OpenAPI](https://huggingface.co/.well-known/openapi.json).
- [Официальное руководство поиска](https://huggingface.co/docs/huggingface_hub/main/guides/search).
- [Квоты и HTTP rate-limit headers](https://huggingface.co/docs/hub/en/rate-limits).
- [Условия платформы](https://huggingface.co/terms-of-service).

API предназначен для программного доступа к Hub. Публичные репозитории могут читаться
без токена; gated/private и требующие согласия модели не входят в этот провайдер.
Условия платформы не заменяют лицензию конкретных весов и датасета.

Проверенные операции:

| Запрос | Результат | Назначение |
| --- | --- | --- |
| `GET https://huggingface.co/api/models?filter=rvc&limit=5&full=true` | PASS, HTTP 200, 5 записей | Поиск кандидатов по тегу; не все RVC имеют этот тег |
| `GET https://huggingface.co/api/models?filter=license:cc0-1.0&search=rvc&limit=100&full=true` | PASS, HTTP 200, 10 записей | Предварительный поиск; CC0-тег не означает одобрение |
| `GET /api/models/PhoenixStormJr/Megaman-Zero-RVC?blobs=true` | PASS, HTTP 200 | SHA ревизии, пути, размеры и LFS SHA-256 |
| `GET /api/models/Thorsten-Voice/Hessisch?blobs=true` | PASS, HTTP 200 | Пример отсечения TTS вместо RVC |
| `GET /{repo}/raw/main/README.md` для 10 кандидатов ниже | PASS, HTTP 200 | Проверка model card; в рабочем реестре закреплять SHA вместо `main` |
| `HEAD /PhoenixStormJr/Megaman-Zero-RVC/resolve/71e3215cef0f28e5fa3718c7608cb8e90970f216/Zero.pth` | PASS, HTTP 302 | Проверка resolver без скачивания тела |

HEAD вернул `x-linked-size=55192782`, `x-linked-etag` с SHA-256
`5f246e3dad19ec5c44737b1b91f24b8bc92f040584d4fe7a10c00bb0ed6595d9`
и перенаправление на `us.aws.cdn.hf.co`. Это свидетельство доступности файла,
**не разрешение включать его в каталог**. Не публиковать подписанные URL из Location:
они временные. В провайдере хранить canonical resolver URL с закреплённым commit SHA.
Не считать произвольный Git blob ID контрольной суммой SHA-256 файла.

Документация различает API, resolver и страницы; квоты считаются по пятиминутным окнам.
Показанная документацией анонимная квота API — 500, resolver — 3000 запросов за окно;
значения для anonymous/free могут меняться. Код должен использовать 429,
`RateLimit`/`RateLimit-Policy`, `Retry-After` при наличии, ограниченные повторы,
debounce и локальный кэш вместо жёсткого предположения о постоянной квоте.
Поисковые результаты надо ограничивать и пагинировать, а не выгружать весь Hub.

Дополнительно выполнены CC0-поиски `voice`, `applio`, `commonvoice`, `thorsten`;
они не дали подтверждённого совместимого RVC-примера. Названия/теги не являются
доказательством версии, лицензии исходников или качества.

## Проверенные кандидаты: ни один не одобрен

Ссылки ведут на закреплённую карточку, проверенную на указанную дату. `unknown`
означает отсутствие достаточных публичных свидетельств в проверенных метаданных,
а не юридическое заключение о модели.

| Кандидат / pinned card | Что обнаружено | Решение |
| --- | --- | --- |
| [PhoenixStormJr/Megaman-Zero-RVC](https://huggingface.co/PhoenixStormJr/Megaman-Zero-RVC/blob/71e3215cef0f28e5fa3718c7608cb8e90970f216/README.md) | CC0-тег, `.pth`, `.index`, ZIP и tar.gz; dataset license/evidence unknown | Не одобрен |
| [PhoenixStormJr/Megaman-X-RVC](https://huggingface.co/PhoenixStormJr/Megaman-X-RVC/blob/be0e595411c4293f6d2266686e86c8fe427fbe64/README.md) | CC0-тег; карточка называет голос из игры; нет CC0 evidence записей | Не одобрен |
| [IdSmile39/RVC2_Kinich_OldEN_GenshinImpact](https://huggingface.co/IdSmile39/RVC2_Kinich_OldEN_GenshinImpact/blob/c9c533b932feef5b7a82171bfc814ec067c59c8f/README.md) | В карточке только license front matter; ZIP | Не одобрен, dataset evidence unknown |
| [IdSmile39/RVC2_ScaramouchePower_EN_GenshinImpact](https://huggingface.co/IdSmile39/RVC2_ScaramouchePower_EN_GenshinImpact/blob/ac30fe606ad76042348e167ee2af8c760a4b2f07/README.md) | Только license front matter; ZIP | Не одобрен, dataset evidence unknown |
| [IdSmile39/RVC2_Kazuha_EN_GenshinImpact](https://huggingface.co/IdSmile39/RVC2_Kazuha_EN_GenshinImpact/blob/d35d9a7d7518852dfa6de2b6a1b89747de33eb30/README.md) | Только license front matter; ZIP | Не одобрен, dataset evidence unknown |
| [IdSmile39/RVC2_Albedo_EN_GenshinImpact](https://huggingface.co/IdSmile39/RVC2_Albedo_EN_GenshinImpact/blob/0df8a2114f3882afdf6aec523e385ee4315a3616/README.md) | Только license front matter; ZIP | Не одобрен, dataset evidence unknown |
| [IdSmile39/RVC_LohenConfident_GenshinImpact](https://huggingface.co/IdSmile39/RVC_LohenConfident_GenshinImpact/blob/edbb1a4ff16b2c93c79eda1e60f1555ec52baff7/README.md) | Только license front matter; `.pth`, `.index`, ZIP | Не одобрен, dataset evidence unknown |
| [jacklai12341/jiangzemin-rvc2](https://huggingface.co/jacklai12341/jiangzemin-rvc2/blob/3d2e36294c17057dca360e1a60e967ea63f18913/README.md) | Автор прямо отделяет свои CC0-компоненты от чужого защищённого/неясного аудиодатасета; `.7z` | Не соответствует политике; 7z также не поддерживается установкой ZIP |
| [IdSmile39/RVC_Alyosha_ENG_GenshinImpact](https://huggingface.co/IdSmile39/RVC_Alyosha_ENG_GenshinImpact/blob/517f061d41bed71e653bd593537aa11cd01ddb52/README.md) | Только license front matter; `.pth`, `.index`, ZIP | Не одобрен, dataset evidence unknown |
| [IdSmile39/RVC2_Alyosha_GenshinImpact](https://huggingface.co/IdSmile39/RVC2_Alyosha_GenshinImpact/blob/6fa64341794c5bd38ac2762a2fdb149c4257f2eb/README.md) | Только license front matter; `.pth`, `.index`, ZIP | Не одобрен, dataset evidence unknown |

[Thorsten-Voice/Hessisch](https://huggingface.co/Thorsten-Voice/Hessisch/tree/0e723353fa9bd939e1cbf83310020e0ffe91c1b3)
имеет CC0-тег, но API описывает **Piper ONNX text-to-speech**, а не inference RVC.
Нельзя выдавать его за совместимый голос только из-за лицензии или слова voice.

## Voice Models и другие публичные каталоги

[Voice Models](https://voice-models.com/) и его
[robots.txt](https://voice-models.com/robots.txt) ответили HTTP 200.
Главная страница показывает поиск и ссылки на внешние HF/Drive-скачивания.
Проверены главная, footer, публичная
[политика конфиденциальности](https://voice-models.com/privacy.php) и поиск
публичной API-документации. **Документированный официальный API и условия,
разрешающие такую программную интеграцию, не установлены.** Это не утверждение,
что API не существует. Автоматический провайдер Voice Models пока не включать.
`robots.txt: Allow: /` не доказывает лицензию контента и не является API-контрактом.
Privacy policy про Google sign-in API не является документацией каталожного API.

[Официальная документация Applio](https://docs.applio.org/getting-started/installing-inference-models/)
объясняет установку `.pth` и соответствующего необязательного `.index` и отличает
inference export от `G_*.pth`/`D_*.pth`. Это источник правил совместимости,
а не одобренный Vocalis каталог целевых голосов.

[Upstream RVC](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI)
предоставляет движок. Лицензия кода не распространяется автоматически на чужие
голоса из community-ссылок. GitHub может быть дополнительным хостингом только для
отдельно проверенного pinned manifest; общий поиск по GitHub не заменяет evidence.
Другой провайдер с проверенным одновременно API и комплектом CC0 RVC в этом
ограниченном исследовании не подтверждён.

## Согласованный контракт прав и источника

Контракт согласован с координатором для реализации ядра каталога:

1. Провайдер возвращает метаданные: `providerId`, исходный `sourceId=owner/repo`,
   неизменяемый `revision`, canonical `sourceUrl`, имя, известные язык/категорию/автора,
   `licenseDeclared`, список безопасных путей/размеров/контрольных сумм.
   Неизвестные поля остаются `null`, категория не выводится как факт из имени.
2. Поисковая выдача по умолчанию имеет непроверенные права/совместимость и причину
   недоступности установки. Удалённый README не может самостоятельно выдать одобрение.
3. Право на установку официального каталога берётся из локального проверенного
   реестра: точные repo+SHA+пути+размеры+SHA-256, `model.license=CC0-1.0`,
   `rights.datasetLicense=CC0-1.0`, `rights.evidenceUrl`, `rights.verifiedAt`.
   Изменившаяся ревизия требует повторной проверки; CC0-тег — только заявка на проверку.
4. Доступность хостинга, подтверждение прав и совместимость — независимые состояния.
   Скачать/установить можно только явно одобренный комплект; приватный локальный импорт
   пользователя сохраняет отдельный статус и не становится одобренной поставкой.
5. Размеры и хеши привязываются к отдельным файлам. Для ZIP явно задать разрешённые
   члены и лимиты; не угадывать комплект при нескольких весах/индексах. Большие training
   archives, `.7z`, tar.gz и исполняемые скрипты не устанавливать автоматически.
6. Сетевой клиент проверяет HTTPS и каждый redirect, не принимает произвольный URL
   клиента или README, не передаёт loopback-токен внешним хостам. CDN разрешать только
   явно, с проверкой назначения; не включать все внешние домены ради одного resolver.
7. Модель после скачивания проверяется через `torch.load(weights_only=True)`:
   inference `weight/config`, RVC v1/v2, speaker embedding, F0/sample rate/архитектура.
   `.pth` и известный хостинг сами по себе не подтверждают безопасность/совместимость.
   Для индекса проверять FAISS, непустоту и размерность 256/768 для v1/v2;
   совпадение размерности не доказывает, что индекс обучен для этих весов.
8. Картинки и аудиодемо требуют собственной проверки прав. Ни thumbnails из README,
   ни community audio не загружать/включать автоматически. Локальный системный TTS-preview
   описан в `docs/MODELS.md` и не требует распространения чужой записи.

## Как получить разрешённый реальный тестовый голос

Нужен авторский inference RVC v1/v2 с явным CC0 на веса и исходные собственные записи,
с публичным свидетельством происхождения/прав, закреплённой ревизией и хешами.
Далее выполняются техническая проверка, тест локального скачивания/установки и
отдельное прослушивание. До этого нельзя отмечать acceptance «скачана и использована
реальная разрешённая модель из каталога» как PASS. Обучение нового голоса и изменение
политики не выполнялись этим исследованием.
