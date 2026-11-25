# Plane Community for Orca

Plugin [Orca](https://orca.dev) untuk **Plane Community Edition self-hosted**. Work item yang di-assign ke
kamu tampil di sidebar kanan Orca, dan **Start** membuat workspace serta branch lalu menjalankan coding agent
dengan isi ticket sebagai konteks.

Plugin ini menggunakan [decadance-dance/orca-plane](https://github.com/decadance-dance/orca-plane) (MIT) sebagai
referensi awal. Plugin tersebut memakai API v2, yang tidak ada di Community Edition. Lapisan Plane di sini ditulis
untuk **API v1**. Tidak berafiliasi dengan Plane.

## Kebutuhan

- Orca 1.4.259 atau lebih baru.
- Plane Community Edition self-hosted dengan API v1. Kontrak API diambil dari source Plane **v1.5.0**. Server
  harus punya `/api/v1/users/me/` dan route `/work-items/`.
- HTTPS. HTTP biasa hanya diizinkan ke `localhost`, karena token akan terkirim tanpa enkripsi.

## Pasang

```bash
orca plugin dev watch .    # selama pengembangan: muat folder ini, reload setiap simpan
orca plugin install .      # pasang dari folder
```

Orca menampilkan akses yang diminta, lalu memberi perintah dengan `--approve`.

Plugin `decadance-dance.plane` memakai shortcut yang sama. Nonaktifkan salah satunya.

## Hubungkan

1. Di Plane, buka **Profile settings → Personal Access Tokens** dan buat token **khusus untuk plugin ini**.
   Batas 60 request per menit berlaku per token.
2. Buka panel Plane di Orca (`Mod+Alt+L`), lalu isi alamat server, workspace slug, dan token.

Token disimpan di secret terenkripsi milik Orca dan hanya dikirim ke server yang kamu isi. Agent tidak pernah
menerima token. Plugin hanya **membaca** Plane.

## Mencari ticket

Ketik di kolom **Search** (ikon kaca pembesar):

- Selama mengetik, yang disaring adalah daftar ticket open milikmu di project yang sedang dipilih.
- **Enter** atau **Search all of Plane** mencari judul dan key di semua project yang kamu ikuti, termasuk ticket
  milik orang lain dan yang sudah closed. Hasilnya tampil di **Other results in Plane**.
- Key lengkap seperti `DEMO-24` atau URL ticket langsung membuka ticketnya saat Enter. Kalau key itu tidak ada,
  teksnya dicari sebagai judul.

Pencarian ke Plane tidak dibatasi pengaturan **Plane projects**. Hasilnya hanya key dan judul; state dan assignee
terlihat di detail.

## Pengaturan

| Pengaturan | Isi |
|---|---|
| Refresh every (minutes) | Jeda refresh latar belakang, 5 sampai 60 menit (bawaan 10) |
| Plane projects | Identifier project yang dibaca, misalnya `WEB, API`. Kosong berarti semua project yang kamu ikuti |
| Default agent for Start | Agent yang terpilih saat Start |
| Start prompt template | Instruksi awal untuk agent: `{key}`, `{url}`, `{ticket}` |

Isi **Plane projects** kalau kamu anggota banyak project. Satu refresh butuh minimal satu request per project.

## Batasan API v1 Community

- Tidak ada filter assignee dan tidak ada daftar lintas project. Plugin membaca tiap project lalu menyaring di
  sisi plugin. Detailnya di [docs/api-v1.md](docs/api-v1.md).
- Paling banyak 2.000 item open dibaca per project. Kalau lebih, daftar ditandai *Partial*.
- Project yang gagal dibaca tetap menampilkan data terakhirnya, dan daftar ditandai *Partial* dengan alasannya.

## Pengembangan

```bash
bin/check                  # validate, render panel, dan test
orca plugin test .         # test saja
orca plugin types .        # tipe Orca untuk editor dan tsc
```

Komentar kode seperti `design D4` merujuk ke
[dokumen openspec di repo referensi](https://github.com/decadance-dance/orca-plane/tree/main/openspec).

## Lisensi

[MIT](LICENSE). Asal kode dicatat di [NOTICE](NOTICE).
