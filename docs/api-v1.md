# Plane API v1 di Community Edition

Kontrak yang dipakai `src/plane/api.ts`, dibaca dari source
[makeplane/plane v1.5.0](https://github.com/makeplane/plane/tree/v1.5.0/apps/api/plane/api).

## Endpoint

| Kebutuhan | Request |
|---|---|
| Identitas token | `GET /api/v1/users/me/` |
| Project yang diikuti | `GET /api/v1/workspaces/{slug}/projects/` |
| Item open per project | `GET /api/v1/workspaces/{slug}/projects/{id}/work-items/?order_by=state__group` |
| Item dari key | `GET /api/v1/workspaces/{slug}/work-items/{KEY-N}/` |
| Cari judul, nomor, atau identifier | `GET /api/v1/workspaces/{slug}/work-items/search/?search=…&workspace_search=true` |
| Item dari UUID, dan parent | `GET /api/v1/workspaces/{slug}/projects/{id}/work-items/{uuid}/` |

## Beda dengan v2 dan cara menanganinya

| Perilaku v1 Community | Penanganan |
|---|---|
| Tidak ada filter `assignee` atau `state_group`; `pql` dan `filters` dijawab 400 | Ambil item per project, saring `assignees` di plugin |
| Tidak ada daftar item lintas project | Baca semua project yang diikuti, 3 sekaligus |
| `order_by=state__group` mengurutkan backlog, unstarted, started, lalu yang closed | Berhenti di item closed pertama, jadi riwayat yang sudah selesai tidak ikut dibaca |
| Urutan itu tidak punya tie-breaker, dan paging memakai offset | Posisi item open tetap jumlahnya, jadi item yang terlewat selalu membuat item lain terbaca dua kali. Kalau ada duplikat, project dibaca ulang dengan `-sequence_id` yang unik |
| `order_by` yang tidak dikenal diam-diam menjadi `-created_at` | Kalau urutan grup tidak naik, project dibaca ulang dengan `-sequence_id` |
| Tidak ada field `identifier` pada item | Key disusun dari `project.identifier` dan `sequence_id` |
| `expand=parent` tidak memuat judul | Parent dibaca dengan request sendiri; kalau gagal, item tampil tanpa parent |
| Token salah dijawab 403, bukan 401 | 403 dari `users/me` berarti token tidak valid |
| Workspace atau project yang tidak ada dijawab 403 | Pesan error menyebut dua kemungkinan: tidak ada, atau bukan anggota |
| Pencarian mencocokkan setiap angka di teks dengan nomor item, jadi `error 500` juga menemukan item nomor 500 | Hasil yang key dan judulnya tidak memuat teks itu dibuang |
| Hasil pencarian tidak memuat state dan assignee | Baris hasil tanpa tombol Start; Start ada di detail |
| Daftar project memuat project publik yang tidak diikuti | Dibuang lewat `is_member` |
| Batas 60 request per menit per token (`API_KEY_RATE_LIMIT`) | Refresh menunggu `Retry-After` sampai 60 detik, lalu berhenti bertanya kalau masih ditolak. Daftar dianggap basi setelah 3 menit |
