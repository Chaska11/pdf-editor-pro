# PDF Editor Pro

Aplikasi PDF editor berbasis web, single-file (`index.html`), berjalan sepenuhnya di browser (client-side) tanpa backend.

## Fitur
- Upload & lihat PDF (mode scroll berkelanjutan maupun satu halaman)
- Crop & Move — potong elemen asli PDF lalu geser posisinya (render ulang resolusi tinggi langsung dari PDF, bukan upscale)
- Pen & Stabilo (highlighter dengan efek blending multiply)
- Bentuk: Kotak, Oval, Lingkaran, Garis (drag untuk menggambar), dengan kontrol ketebalan garis
- Teks baru dengan pilihan font family & ukuran font (angka)
- **Edit Teks Asli PDF** — klik baris teks yang sudah ada di PDF untuk langsung mengeditnya
- Rotasi halaman & zoom in/out (objek editan ikut menyesuaikan posisi/orientasi)
- Undo/Redo per halaman
- Gabung PDF, sisip halaman kosong, hapus halaman
- Export hasil edit ke file PDF baru

## Cara Menjalankan
Tidak perlu instalasi atau server. Cukup buka `index.html` langsung di browser modern (Chrome/Edge/Firefox terbaru disarankan), atau jalankan lewat static server sederhana:

```bash
python3 -m http.server 8000
# lalu buka http://localhost:8000
```

## Teknologi
- [PDF.js](https://mozilla.github.io/pdf.js/) — render & ekstraksi teks PDF
- [PDF-Lib](https://pdf-lib.js.org/) — penyusunan ulang & export PDF
- [Fabric.js](http://fabricjs.com/) — canvas interaktif untuk semua objek editan
- [Tailwind CSS](https://tailwindcss.com/) & [Lucide Icons](https://lucide.dev/)

## Catatan
Semua library dimuat lewat CDN, jadi dibutuhkan koneksi internet saat aplikasi dijalankan.
