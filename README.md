# PDF Editor Pro

Editor PDF berbasis browser (client-side sepenuhnya, tanpa server/backend) dengan mode continuous-scroll, objek interaktif, dan beberapa alat konversi/kompresi. Dibangun dengan PDF.js, PDF-Lib, Fabric.js, dan JSZip.

## Struktur Berkas

```
├── index.html   # Markup & struktur UI
├── style.css    # Semua styling kustom (di luar utility class Tailwind)
├── app.js       # Seluruh logika aplikasi
└── README.md
```

Ketiga file (`index.html`, `style.css`, `app.js`) **harus berada dalam satu folder yang sama** karena saling terhubung lewat path relatif. Cukup buka `index.html` di browser — tidak perlu server ataupun proses build.

## Fitur

### Membaca & Navigasi
- Render PDF continuous-scroll (semua halaman sekaligus) atau mode satu halaman
- Scroll-spy: halaman aktif terdeteksi otomatis berdasarkan posisi scroll
- Navigasi halaman cepat (tombol prev/next, klik thumbnail sidebar)
- Zoom in/out dengan objek editan yang ikut menyesuaikan posisi & skala
- Render tajam di layar high-DPI/Retina (dibatasi maks. 2x untuk menjaga performa & ukuran file)

### Alat Edit per Halaman
- **Pilih & Geser** — pilih, pindahkan, resize, atau hapus objek (termasuk multi-seleksi)
- **Pen** & **Stabilo (highlighter)** — coretan bebas dengan ketebalan & warna yang bisa diatur
- **Tambah Teks** — kotak teks baru dengan pilihan font, ukuran, dan warna
- **Edit Teks Asli PDF** — klik baris teks yang sudah ada di PDF untuk mengeditnya langsung di tempat
- **Bentuk** — kotak, oval, lingkaran, garis
- **Whiteout** — bidang putih untuk menutupi teks/latar asli (misalnya watermark hasil scan)
- **Tanda Tangan** — gambar tanda tangan lewat pad, lalu tempelkan ke halaman
- **Simbol Cepat** — centang, silang, panah, bintang, dll
- **Crop & Geser Elemen Asli** — potong sebagian PDF asli (dirender ulang pada resolusi tinggi langsung dari data vektor) menjadi elemen gambar yang bisa digeser terpisah
- **Undo / Redo** per halaman, plus shortcut keyboard (`Ctrl+Z`, `Ctrl+Y`, panah untuk menggeser objek terpilih)
- **Putar** & **Hapus** halaman (objek editan ikut menyesuaikan orientasi saat halaman diputar)

### Alat Halaman (dropdown)
- **Gabungkan PDF** — satukan beberapa file PDF jadi satu
- **Pisahkan (Split) PDF** — ekstrak rentang halaman tertentu jadi file baru
- **Sisipkan Halaman Kosong**
- **Kompres PDF** — pilih target ukuran (di bawah 1 MB / 500 KB / 300 KB / 100 KB); mencoba beberapa level kompresi berurutan dari kualitas terbaik ke paling agresif, berhenti begitu ukurannya sudah memenuhi target
- **Gambar ke PDF** — gabungkan beberapa gambar jadi satu PDF (satu gambar = satu halaman A4), dengan target ukuran yang sama seperti Kompres PDF
- **Kompres Gambar** — kompres gambar tanpa dikonversi ke PDF; target ukuran berlaku per gambar; opsi mempertahankan transparansi PNG; hasil lebih dari satu gambar otomatis dibungkus jadi satu ZIP

### Ekspor / Simpan
Semua fitur unduhan (Export, Kompres PDF, Split, Gambar ke PDF, Kompres Gambar) menggunakan dialog **"Save As"** native browser (File System Access API) sehingga pengguna bisa memilih folder & nama file sendiri.
- **Didukung**: Chrome, Edge, Brave (versi desktop), dan browser Chromium lain — wajib berjalan di **HTTPS atau localhost**.
- **Tidak didukung** (Firefox, Safari, kebanyakan browser mobile): otomatis *fallback* ke unduhan biasa ke folder Downloads tanpa error.

## Batasan yang Perlu Diketahui

- **Kompres PDF / Kompres Gambar mengubah konten jadi gambar (rasterisasi).** Ini satu-satunya cara realistis mencapai target ukuran yang presisi di browser tanpa server. Efeknya, teks pada hasil kompresi PDF tidak lagi bisa di-select/dicari. Untuk gambar, mode JPEG (default) memberi kontrol ukuran paling presisi; mode "Pertahankan PNG" hanya mengecilkan lewat resolusi (tidak ada kenop kualitas untuk format lossless), sehingga kurang presisi mengejar target ukuran tertentu.
- **Dialog Save As** hanya tersedia di browser berbasis Chromium & context aman (HTTPS/localhost); di luar itu otomatis fallback ke unduhan biasa.
- Ukuran render dibatasi maksimal 2x `devicePixelRatio` untuk mencegah file/gambar membengkak di perangkat dengan rasio piksel tinggi (mis. banyak HP Android dengan DPR 3).

## Dependensi (CDN)

| Library | Kegunaan |
|---|---|
| Tailwind CSS | Utility classes untuk layout & styling |
| Lucide | Ikon |
| PDF.js | Membaca & merender PDF |
| PDF-Lib | Manipulasi struktur PDF (split, merge, rotate, embed gambar) |
| Fabric.js | Kanvas objek interaktif (pilih, geser, resize, gambar bebas) |
| JSZip | Membungkus beberapa gambar hasil kompresi jadi satu ZIP |

Semua di-load lewat CDN — tidak perlu `npm install` atau proses build apa pun.

## Riwayat Perbaikan Penting

- Toolbar tidak lagi ikut ter-scroll (viewport dikunci ke `#editor-viewport`, bukan `<html>`/`<body>`)
- Buffer PDF asli tidak lagi rusak setelah dimuat pdf.js (selalu dikirim salinan `.slice()`, bukan reference asli)
- Objek editan (teks, bentuk, hasil crop) ikut menyesuaikan posisi saat zoom & rotasi halaman berubah
- Highlighter tidak lagi dobel-transparan, dan memakai blend mode `multiply` agar terlihat seperti stabilo asli
- Penghapusan objek menangani kasus multi-seleksi (`ActiveSelection`) dengan benar — sebelumnya objek yang "terlihat terhapus" bisa muncul lagi saat export
- Border dashed alat Whiteout (indikator visual editor) tidak lagi ikut ter-bake ke PDF hasil ekspor
- Dropdown "Alat Halaman" diganti dari hover-based ke klik-toggle (menghindari dropdown tertutup sendiri akibat celah hover)
- Scroll PDF dioptimalkan: `scroll-smooth` yang bentrok dengan scroll manual dihapus, dan scroll-spy di-throttle dengan `requestAnimationFrame`