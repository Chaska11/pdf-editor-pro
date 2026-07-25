// Set worker pdf.js
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';

        // FIX: dibatasi maksimal 2x. Device dengan devicePixelRatio 3 (banyak HP Android)
        // kalau dipakai penuh akan membuat gambar hasil crop jadi sangat besar
        // (resolusi kali lipat dari kuadrat rasio ini), yang bikin data base64
        // gambar bengkak dan berisiko membuat proses export PDF gagal/macet.
        // 2x sudah cukup tajam untuk kebutuhan tampilan & cetak dokumen biasa.
        const RENDER_DPR = Math.min(window.devicePixelRatio || 1, 2);

        // State Manager Aplikasi
        let pdfDataBytes = null;       // Uint8Array dari PDF asli
        let pdfDocInstance = null;     // Objek pdf.js
        let currentPageNum = 1;        // Halaman aktif
        let totalPages = 0;            // Total Halaman
        let currentZoom = 1.0;         // Skala pembesaran
        let rotationStates = {};       // Putaran halaman (halaman -> derajat)
        let deletedPages = new Set();  // Menyimpan halaman yang dihapus oleh user
        
        let activeTool = 'select';     // Tool bawaan default
        let globalColor = '#ef4444';   // Default warna merah
        let strokeWidth = 4;           // Default ketebalan garis (pen/highlighter/shapes)
        let fontSize = 20;             // Default ukuran font (angka px)
        let selectedFontFamily = 'Arial, sans-serif'; // Default font family
        
        let viewMode = 'scroll';       // View mode default: 'scroll' atau 'single'

        // Referensi objek "page" & "viewport" pdf.js per halaman -- dibutuhkan untuk
        // render ulang resolusi tinggi saat Crop & Move, dan untuk ekstraksi teks asli
        // pada fitur "Edit Teks PDF".
        let pdfPageProxies = {};
        let pdfPageViewports = {};

        // Cache baris teks asli PDF (hasil pengelompokan text items per baris) untuk
        // fitur "Edit Teks PDF", dan penanda baris mana yang sudah dikonversi jadi
        // kotak teks yang bisa diedit (supaya tidak dobel kalau diklik lagi).
        let pageTextLinesCache = {};
        let convertedTextLines = {};
        
        // Objek Cache untuk menyimpan Coretan/Objek Fabric.js per halaman (halaman -> JSON State)
        let pageObjectsCache = {};

        // SISTEM UNDO & REDO STATE (Page -> Stack)
        let pageUndoStacks = {};       // Menyimpan tumpukan histori halaman (Page -> Array)
        let pageRedoStacks = {};       // Menyimpan tumpukan redo halaman (Page -> Array)
        let isRespondingToStateChange = false; // Mencegah loop penyimpanan state

        // Penampung referensi objek-objek Canvas Fabric aktif per halaman
        let activeFabricCanvases = {};

        // Canvas yang saat ini sedang diedit/dipilih oleh user secara aktif
        let fCanvas = null;

        // FIX FONT: <link> Google Fonts di <head> cuma MEMESAN font, bukan
        // menjamin sudah selesai dimuat saat script ini jalan. Kalau user
        // menambahkan teks dengan Google Font sebelum font-nya benar-benar
        // siap, canvas akan menampilkan font fallback sampai ada re-render.
        // document.fonts.ready memastikan begitu semua font di <head> selesai
        // dimuat, semua canvas yang sudah ada langsung digambar ulang dengan
        // font yang benar.
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(() => {
                Object.values(activeFabricCanvases).forEach(c => c.renderAll());
            });
        }

        // Pointer Tanda Tangan (Signature Pad)
        const sigPad = document.getElementById('sig-pad');
        const ctxSig = sigPad.getContext('2d');
        let drawingSig = false;

        // Dom Elements
        const pdfFileInput = document.getElementById('pdf-file-input');
        const pdfFileInputWelcome = document.getElementById('pdf-file-input-welcome');
        const welcomeState = document.getElementById('welcome-state');
        const scrollWorkspace = document.getElementById('scroll-workspace');
        const editorViewport = document.getElementById('editor-viewport');

        // Hubungkan Input File
        pdfFileInput.addEventListener('change', handleFileSelect);
        pdfFileInputWelcome.addEventListener('change', handleFileSelect);

        // Toast Alert System
        function showToast(message, type = 'info') {
            const toast = document.getElementById('toast-message');
            const icon = document.getElementById('toast-icon');
            const text = document.getElementById('toast-text');
            text.innerText = message;

            if (type === 'success') {
                icon.innerHTML = '<i data-lucide="check-circle" class="text-emerald-500 w-5 h-5"></i>';
            } else if (type === 'error') {
                icon.innerHTML = '<i data-lucide="alert-triangle" class="text-rose-500 w-5 h-5"></i>';
            } else {
                icon.innerHTML = '<i data-lucide="info" class="text-blue-500 w-5 h-5"></i>';
            }
            lucide.createIcons();

            toast.classList.remove('translate-y-20', 'opacity-0');
            toast.classList.add('translate-y-0', 'opacity-100');

            setTimeout(() => {
                toast.classList.remove('translate-y-0', 'opacity-100');
                toast.classList.add('translate-y-20', 'opacity-0');
            }, 3000);
        }

        // Buka Berkas PDF
        async function handleFileSelect(e) {
            const file = e.target.files[0];
            if (!file) return;

            showToast("Membuka PDF...", "info");
            const reader = new FileReader();
            reader.onload = async function() {
                pdfDataBytes = new Uint8Array(this.result);
                await loadPdfDocument();
            };
            reader.readAsArrayBuffer(file);
        }

        // Proses Memuat Dokumen PDF
        async function loadPdfDocument() {
            try {
                // FIX PENTING: pdf.js men-transfer (bukan menyalin) ArrayBuffer di
                // dalam Uint8Array ke Web Worker-nya untuk efisiensi. Efek
                // sampingnya, `pdfDataBytes` ASLI jadi kosong/rusak setelah baris
                // ini (buffer-nya "detached"). Kalau pdfDataBytes langsung dikasih
                // di sini, nanti pas export/save PDF-Lib mencoba baca ulang
                // pdfDataBytes, hasilnya rusak -> "No PDF header found".
                // Solusinya: selalu kasih ke pdf.js SALINAN datanya (.slice()),
                // bukan reference aslinya, supaya pdfDataBytes tetap utuh.
                const loadingTask = pdfjsLib.getDocument({ data: pdfDataBytes.slice() });
                pdfDocInstance = await loadingTask.promise;
                
                totalPages = pdfDocInstance.numPages;
                currentPageNum = 1;
                rotationStates = {};
                deletedPages = new Set();
                pageObjectsCache = {};
                pageUndoStacks = {};
                pageRedoStacks = {};
                
                // Bersihkan fabric instances yang lama
                Object.values(activeFabricCanvases).forEach(c => c.dispose());
                activeFabricCanvases = {};

                welcomeState.classList.add('hidden');
                scrollWorkspace.classList.remove('hidden');

                // Aktifkan Kontrol
                document.getElementById('btn-export').removeAttribute('disabled');
                document.getElementById('btn-rotate-page').removeAttribute('disabled');
                document.getElementById('btn-delete-page').removeAttribute('disabled');
                document.getElementById('total-pages-num').innerText = totalPages;

                await renderAllPages();
                generateSidebarThumbnails();
                
                showToast("PDF siap diedit!", "success");
            } catch (err) {
                console.error(err);
                showToast("Berkas gagal dimuat. Pastikan itu file PDF valid.", "error");
            }
        }

        // RENDER SEMUA HALAMAN SECARA VERTIKAL (CONTINUOUS SCROLL / SINGLE-PAGE SINKRON)
        async function renderAllPages() {
            if (!pdfDocInstance) return;
            
            // Simpan posisi scroll sebelum render
            const scrollPos = editorViewport.scrollTop;

            scrollWorkspace.innerHTML = ''; // Bersihkan container workspace

            // Reset cache posisi teks (posisinya berubah tiap kali zoom/rotasi berubah)
            pageTextLinesCache = {};
            convertedTextLines = {};

            for (let i = 1; i <= totalPages; i++) {
                if (deletedPages.has(i)) continue;

                // Skip halaman lain jika berada dalam mode single-page tunggal
                if (viewMode === 'single' && i !== currentPageNum) {
                    continue;
                }

                // Buat kontainer halaman pembungkus
                const pageContainer = document.createElement('div');
                pageContainer.className = `pdf-page-container ${i === currentPageNum ? 'active-page-border' : ''}`;
                pageContainer.id = `page-wrapper-${i}`;
                pageContainer.dataset.pageNum = i;

                // Ambil halaman asli PDF
                const page = await pdfDocInstance.getPage(i);
                const rot = rotationStates[i] || 0;
                const viewport = page.getViewport({ scale: currentZoom, rotation: rot });

                // Simpan referensi untuk dipakai fitur Crop resolusi tinggi & Edit Teks PDF
                pdfPageProxies[i] = page;
                pdfPageViewports[i] = viewport;

                pageContainer.style.width = `${viewport.width}px`;
                pageContainer.style.height = `${viewport.height}px`;

                // Buat canvas latar belakang PDF asli
                // FIX BURAM: render pada resolusi devicePixelRatio (dibatasi max 2x,
                // lihat RENDER_DPR) agar tajam di layar Retina/high-DPI. Ukuran
                // TAMPILAN (CSS) tetap sama, hanya resolusi bitmap di dalamnya yang
                // diperbesar, lalu PDF.js diberi tahu lewat parameter `transform`
                // supaya konten digambar mengisi resolusi itu.
                const dpr = RENDER_DPR;
                const bgCanvas = document.createElement('canvas');
                bgCanvas.className = 'pdf-bg-canvas';
                bgCanvas.width = viewport.width * dpr;
                bgCanvas.height = viewport.height * dpr;
                bgCanvas.style.width = `${viewport.width}px`;
                bgCanvas.style.height = `${viewport.height}px`;
                bgCanvas.dataset.dpr = dpr;
                
                // Buat canvas overlay interaktif Fabric.js
                const overlayCanvas = document.createElement('canvas');
                overlayCanvas.className = 'fabric-overlay-canvas';
                overlayCanvas.id = `fabric-canvas-${i}`;

                pageContainer.appendChild(bgCanvas);
                pageContainer.appendChild(overlayCanvas);
                scrollWorkspace.appendChild(pageContainer);

                // Render visual halaman asli PDF (di-scale ke resolusi devicePixelRatio)
                const renderContext = {
                    canvasContext: bgCanvas.getContext('2d'),
                    viewport: viewport,
                    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
                };
                await page.render(renderContext).promise;

                // Inisialisasi Fabric Canvas untuk halaman ini
                const fPageCanvas = new fabric.Canvas(`fabric-canvas-${i}`, {
                    width: viewport.width,
                    height: viewport.height,
                    selection: true,
                    preserveObjectStacking: true
                });

                // Simpan referensi canvas ke map aktif
                activeFabricCanvases[i] = fPageCanvas;

                // FIX GULIR MOUSE: Terjemahkan perputaran roda mouse di atas canvas Fabric menjadi pergeseran scroll kontainer
                fPageCanvas.on('mouse:wheel', function(opt) {
                    const delta = opt.e.deltaY;
                    editorViewport.scrollTop += delta;
                    opt.e.preventDefault();
                    opt.e.stopPropagation();
                });

                // Hubungkan event-event Fabric untuk manajemen Undo-Redo & Sync Cache
                fPageCanvas.on('path:created', function(e) {
                    if (activeTool === 'highlighter') {
                        // FIX: sebelumnya opacity 0.45 ditumpuk LAGI di atas warna
                        // brush yang sudah punya alpha 0.45 sendiri (hexToRgbA),
                        // hasilnya jadi dobel transparan (~0.2) dan tidak konsisten.
                        // Sekarang transparansi cukup dari warna brush saja, dan kita
                        // tambahkan mode "multiply" supaya blending-nya terlihat
                        // seperti stabilo asli menembus di atas teks, bukan sekadar
                        // garis pudar seperti pen.
                        e.path.set({
                            opacity: 1,
                            globalCompositeOperation: 'multiply'
                        });
                        fPageCanvas.renderAll();
                    }
                    saveStateToHistory(i, fPageCanvas);
                });

                fPageCanvas.on('object:modified', () => saveStateToHistory(i, fPageCanvas));
                fPageCanvas.on('object:added', () => saveStateToHistory(i, fPageCanvas));
                fPageCanvas.on('object:removed', () => saveStateToHistory(i, fPageCanvas));

                // Deteksi klik pada halaman untuk mengaktifkan fCanvas utama
                fPageCanvas.on('mouse:down', () => {
                    setActivePage(i);
                });

                // Muat objek tersimpan dari cache jika ada
                if (pageObjectsCache[i]) {
                    isRespondingToStateChange = true;
                    fPageCanvas.loadFromJSON(pageObjectsCache[i], () => {
                        fPageCanvas.renderAll();
                        isRespondingToStateChange = false;
                        
                        if (!pageUndoStacks[i]) {
                            pageUndoStacks[i] = [JSON.stringify(fPageCanvas.toJSON())];
                            pageRedoStacks[i] = [];
                        }
                    });
                } else {
                    if (!pageUndoStacks[i]) {
                        pageUndoStacks[i] = [JSON.stringify(fPageCanvas.toJSON())];
                        pageRedoStacks[i] = [];
                    }
                }
            }

            // Kembalikan posisi scroll viewport jika dalam mode scroll
            if (viewMode === 'scroll') {
                editorViewport.scrollTop = scrollPos;
            }

            // Atur halaman aktif utama
            setActivePage(currentPageNum);
            setupScrollSpy(); // Aktifkan pendeteksi halaman aktif berdasarkan scroll
        }

        // FIX: Gulirkan HANYA di dalam #editor-viewport, tidak pernah menyentuh
        // scroll window/document. Menggantikan el.scrollIntoView() bawaan yang
        // rawan ikut menggeser ancestor lain (termasuk toolbar) jika ada
        // ketidaksesuaian tinggi container akibat flexbox.
        function scrollPageIntoView(el) {
            if (!el) return;
            const elRect = el.getBoundingClientRect();
            const viewportRect = editorViewport.getBoundingClientRect();
            // Posisi elemen relatif terhadap konten yang sudah discroll saat ini
            const elTopWithinContent = (elRect.top - viewportRect.top) + editorViewport.scrollTop;
            const targetTop = elTopWithinContent - (editorViewport.clientHeight / 2) + (elRect.height / 2);
            editorViewport.scrollTo({
                top: Math.max(0, targetTop),
                behavior: 'smooth'
            });
        }

        // ================== FITUR: EDIT TEKS ASLI PDF ==================
        // Mengambil semua "text item" dari PDF.js untuk satu halaman, lalu
        // mengelompokkannya jadi baris-baris (karena PDF.js biasanya memecah satu
        // baris kalimat jadi beberapa potongan/item kecil per kata atau per gaya
        // huruf). Hasilnya baru dihitung sekali per halaman lalu di-cache, supaya
        // klik berikutnya tidak perlu re-ekstraksi dari awal.
        async function getPageTextLines(pageNum) {
            if (pageTextLinesCache[pageNum]) return pageTextLinesCache[pageNum];

            const page = pdfPageProxies[pageNum];
            const viewport = pdfPageViewports[pageNum];
            if (!page || !viewport) return [];

            const textContent = await page.getTextContent();

            // Hitung bounding box tiap item teks dalam satuan px kanvas (CSS px),
            // memakai kombinasi transform milik item & viewport halaman -- ini
            // rumus baku yang sama dipakai PDF.js sendiri untuk text-layer-nya.
            const itemBoxes = textContent.items
                .filter(item => item.str && item.str.trim().length > 0)
                .map(item => {
                    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
                    const fontHeight = Math.hypot(tx[2], tx[3]);
                    const widthPx = item.width * Math.hypot(tx[0], tx[1]);
                    return {
                        text: item.str,
                        left: tx[4],
                        baseline: tx[5],
                        top: tx[5] - fontHeight,
                        width: widthPx,
                        height: fontHeight
                    };
                });

            // Kelompokkan item-item yang baseline-nya berdekatan (dianggap satu
            // baris yang sama), lalu urutkan dari kiri ke kanan dan gabungkan
            // teksnya jadi satu baris utuh yang bisa diedit sekaligus.
            const LINE_TOLERANCE_PX = 3;
            const sorted = [...itemBoxes].sort((a, b) => a.baseline - b.baseline || a.left - b.left);
            const lines = [];

            sorted.forEach(box => {
                let line = lines.find(l => Math.abs(l.baseline - box.baseline) <= LINE_TOLERANCE_PX);
                if (!line) {
                    line = { baseline: box.baseline, items: [] };
                    lines.push(line);
                }
                line.items.push(box);
            });

            const groupedLines = lines.map(line => {
                line.items.sort((a, b) => a.left - b.left);
                let text = '';
                let prevRight = null;
                line.items.forEach(box => {
                    if (prevRight !== null && (box.left - prevRight) > box.height * 0.3) {
                        text += ' ';
                    }
                    text += box.text;
                    prevRight = box.left + box.width;
                });

                const left = Math.min(...line.items.map(b => b.left));
                const top = Math.min(...line.items.map(b => b.top));
                const right = Math.max(...line.items.map(b => b.left + b.width));
                const bottom = Math.max(...line.items.map(b => b.top + b.height));
                const maxHeight = Math.max(...line.items.map(b => b.height));

                return {
                    text: text,
                    left: left,
                    top: top,
                    width: right - left,
                    height: bottom - top,
                    fontSize: maxHeight
                };
            });

            pageTextLinesCache[pageNum] = groupedLines;
            return groupedLines;
        }

        // Cari baris teks yang mengandung titik klik (dengan sedikit padding
        // toleransi), dan yang belum pernah dikonversi jadi kotak teks editable.
        function findTextLineAtPoint(lines, pageNum, x, y) {
            const PADDING = 3;
            const converted = convertedTextLines[pageNum] || new Set();

            for (let idx = 0; idx < lines.length; idx++) {
                if (converted.has(idx)) continue;
                const l = lines[idx];
                if (
                    x >= l.left - PADDING && x <= l.left + l.width + PADDING &&
                    y >= l.top - PADDING && y <= l.top + l.height + PADDING
                ) {
                    return { index: idx, line: l };
                }
            }
            return null;
        }

        // SET DAN HIGHLIGHT HALAMAN AKTIF
        function setActivePage(pageNum) {
            if (!pdfDocInstance || deletedPages.has(pageNum)) return;

            currentPageNum = pageNum;
            document.getElementById('current-page-num').innerText = currentPageNum;

            // Alihkan pointer canvas utama yang sedang diedit ke halaman ini
            fCanvas = activeFabricCanvases[pageNum];

            // Beri efek border biru pada halaman aktif
            for (let i = 1; i <= totalPages; i++) {
                const wrapper = document.getElementById(`page-wrapper-${i}`);
                if (wrapper) {
                    if (i === pageNum) {
                        wrapper.classList.add('active-page-border');
                    } else {
                        wrapper.classList.remove('active-page-border');
                    }
                }
            }

            updateSidebarHighlight();
            updateUndoRedoButtons();
            applyToolState();
        }

        // SCROLL SPY: MENDETEKSI HALAMAN AKTIF BERDASARKAN POSISI SCROLL VERTIKAL
        // FIX PERFORMA: sebelumnya fungsi ini (yang memanggil getBoundingClientRect
        // untuk SETIAP halaman PDF) langsung dijalankan di tiap event 'scroll'
        // mentah -- padahal event scroll bisa menembak puluhan kali per detik.
        // Pada dokumen dengan banyak halaman, itu jadi kerja berat yang berulang
        // dan bikin scroll kerasa berat/nge-lag. Sekarang di-throttle dengan
        // requestAnimationFrame supaya perhitungan ini paling banyak jalan
        // sekali per frame render browser (idealnya ~60x/detik, bukan tanpa batas).
        let scrollSpyTicking = false;
        function setupScrollSpy() {
            if (viewMode !== 'scroll') return;

            editorViewport.onscroll = () => {
                if (scrollSpyTicking) return;
                scrollSpyTicking = true;

                requestAnimationFrame(() => {
                    const pageContainers = document.querySelectorAll('.pdf-page-container');
                    let activePage = currentPageNum;
                    let minDistance = Infinity;
                    const viewportRect = editorViewport.getBoundingClientRect();

                    pageContainers.forEach(container => {
                        const rect = container.getBoundingClientRect();

                        // Hitung jarak tengah halaman ke tengah viewport area
                        const containerCenter = rect.top + rect.height / 2;
                        const viewportCenter = viewportRect.top + viewportRect.height / 2;
                        const distance = Math.abs(containerCenter - viewportCenter);

                        if (distance < minDistance) {
                            minDistance = distance;
                            activePage = parseInt(container.dataset.pageNum);
                        }
                    });

                    if (activePage !== currentPageNum) {
                        setActivePage(activePage);
                    }
                    scrollSpyTicking = false;
                });
            };
        }

        // SINKRONISASI CACHE OBJEK HALAMAN AKTIF
        function saveCurrentPageObjects() {
            if (!fCanvas || !pdfDocInstance) return;
            pageObjectsCache[currentPageNum] = JSON.stringify(fCanvas.toJSON());
        }

        // FIX ZOOM: waktu di-zoom in/out, ukuran halaman PDF berubah tapi posisi
        // objek hasil editan (teks, shape, crop, dll) sebelumnya TIDAK ikut
        // disesuaikan -- jadi kelihatan "tertinggal"/geser dari PDF-nya. Fungsi ini
        // menggeser & menskalakan ulang SEMUA objek di SEMUA halaman yang sedang
        // aktif, sebanding dengan rasio perubahan zoom, tepat sebelum re-render,
        // supaya semuanya tetap "menempel" pas di posisi PDF aslinya.
        function rescaleAllPageObjects(ratio) {
            if (!ratio || ratio === 1) return;

            Object.keys(activeFabricCanvases).forEach(pageNumKey => {
                const canvas = activeFabricCanvases[pageNumKey];
                canvas.getObjects().forEach(obj => {
                    obj.set({
                        left: obj.left * ratio,
                        top: obj.top * ratio,
                        scaleX: (obj.scaleX || 1) * ratio,
                        scaleY: (obj.scaleY || 1) * ratio
                    });
                    obj.setCoords();
                });
                canvas.renderAll();

                // Simpan balik ke cache dalam koordinat yang sudah disesuaikan,
                // supaya renderAllPages() berikutnya memuat posisi yang benar.
                pageObjectsCache[pageNumKey] = JSON.stringify(canvas.toJSON());
            });
        }

        // ===== Helper matriks affine 2D (dipakai untuk memetakan posisi objek
        // antar orientasi viewport saat halaman diputar) =====
        function invertAffineMatrix(m) {
            const [a, b, c, d, e, f] = m;
            const det = a * d - b * c;
            return [
                d / det, -b / det,
                -c / det, a / det,
                (c * f - d * e) / det, (b * e - a * f) / det
            ];
        }

        function applyAffineMatrix(m, x, y) {
            const [a, b, c, d, e, f] = m;
            return [a * x + c * y + e, b * x + d * y + f];
        }

        // Memetakan satu titik dari ruang koordinat viewport LAMA ke viewport BARU.
        // Caranya: titik di-"kembalikan" dulu ke ruang koordinat PDF asli (lewat
        // invers transform viewport lama), lalu diproyeksikan ke ruang viewport
        // baru (lewat transform viewport baru). Ini memakai matriks transform
        // dari pdf.js sendiri, jadi dijamin konsisten dengan bagaimana PDF.js
        // memutar & menskalakan konten aslinya.
        function mapPointBetweenViewports(x, y, oldViewport, newViewport) {
            const inv = invertAffineMatrix(oldViewport.transform);
            const [pdfX, pdfY] = applyAffineMatrix(inv, x, y);
            return applyAffineMatrix(newViewport.transform, pdfX, pdfY);
        }

        // FIX ROTASI: waktu halaman diputar, isi PDF-nya (canvas latar) otomatis
        // berputar lewat viewport pdf.js -- tapi objek editan (teks, shape, hasil
        // crop, dll) sebelumnya diam saja di posisi/orientasi lama. Fungsi ini
        // memutar & memindahkan SETIAP objek pada satu halaman supaya tetap
        // "menempel" di posisi yang sama relatif terhadap PDF-nya, walau
        // orientasi halaman berubah.
        function rotateAllObjectsOnPage(pageNum, oldViewport, newViewport, deltaDegrees) {
            const canvas = activeFabricCanvases[pageNum];
            if (!canvas || !oldViewport || !newViewport) return;

            canvas.getObjects().forEach(obj => {
                // Pakai TITIK PUSAT objek (bukan left/top) karena Fabric memutar
                // objek di sekitar titik pusatnya, bukan sudut kiri-atas.
                const centerOld = obj.getCenterPoint();
                const [newCx, newCy] = mapPointBetweenViewports(centerOld.x, centerOld.y, oldViewport, newViewport);

                obj.angle = ((obj.angle || 0) + deltaDegrees + 360) % 360;
                obj.setPositionByOrigin(new fabric.Point(newCx, newCy), 'center', 'center');
                obj.setCoords();
            });

            canvas.renderAll();
            pageObjectsCache[pageNum] = JSON.stringify(canvas.toJSON());
        }

        // FUNGSI MANAJEMEN RIWAYAT (UNDO/REDO ACTIONS)
        function saveStateToHistory(pageNum, canvasObj) {
            if (isRespondingToStateChange || !canvasObj) return;
            
            const currentState = JSON.stringify(canvasObj.toJSON());
            
            if (!pageUndoStacks[pageNum]) {
                pageUndoStacks[pageNum] = [];
            }
            if (!pageRedoStacks[pageNum]) {
                pageRedoStacks[pageNum] = [];
            }

            const len = pageUndoStacks[pageNum].length;
            if (len > 0 && pageUndoStacks[pageNum][len - 1] === currentState) {
                return;
            }

            pageUndoStacks[pageNum].push(currentState);
            pageRedoStacks[pageNum] = []; // Reset Redo
            
            updateUndoRedoButtons();
            pageObjectsCache[pageNum] = currentState; // Sinkronkan ke cache
        }

        function triggerUndo() {
            const page = currentPageNum;
            const canvasObj = activeFabricCanvases[page];
            if (!canvasObj || !pageUndoStacks[page] || pageUndoStacks[page].length <= 1) return;

            const currentState = pageUndoStacks[page].pop();
            if (!pageRedoStacks[page]) pageRedoStacks[page] = [];
            pageRedoStacks[page].push(currentState);

            const prevState = pageUndoStacks[page][pageUndoStacks[page].length - 1];
            
            isRespondingToStateChange = true;
            canvasObj.loadFromJSON(prevState, () => {
                canvasObj.renderAll();
                isRespondingToStateChange = false;
                updateUndoRedoButtons();
                pageObjectsCache[page] = prevState;
            });
        }

        function triggerRedo() {
            const page = currentPageNum;
            const canvasObj = activeFabricCanvases[page];
            if (!canvasObj || !pageRedoStacks[page] || pageRedoStacks[page].length === 0) return;

            const nextState = pageRedoStacks[page].pop();
            pageUndoStacks[page].push(nextState);

            isRespondingToStateChange = true;
            canvasObj.loadFromJSON(nextState, () => {
                canvasObj.renderAll();
                isRespondingToStateChange = false;
                updateUndoRedoButtons();
                pageObjectsCache[page] = nextState;
            });
        }

        function updateUndoRedoButtons() {
            const page = currentPageNum;
            const undoBtn = document.getElementById('btn-undo');
            const redoBtn = document.getElementById('btn-redo');

            if (pageUndoStacks[page] && pageUndoStacks[page].length > 1) {
                undoBtn.removeAttribute('disabled');
                undoBtn.classList.remove('text-slate-500', 'hover:text-slate-500');
                undoBtn.classList.add('text-slate-200', 'hover:text-white');
            } else {
                undoBtn.setAttribute('disabled', 'true');
                undoBtn.classList.remove('text-slate-200', 'hover:text-white');
                undoBtn.classList.add('text-slate-500', 'hover:text-slate-500');
            }

            if (pageRedoStacks[page] && pageRedoStacks[page].length > 0) {
                redoBtn.removeAttribute('disabled');
                redoBtn.classList.remove('text-slate-500', 'hover:text-slate-500');
                redoBtn.classList.add('text-slate-200', 'hover:text-white');
            } else {
                redoBtn.setAttribute('disabled', 'true');
                redoBtn.classList.remove('text-slate-200', 'hover:text-white');
                redoBtn.classList.add('text-slate-500', 'hover:text-slate-500');
            }
        }

        // Buat Thumbnail Halaman pada Sidebar
        function generateSidebarThumbnails() {
            const container = document.getElementById('pages-container');
            container.innerHTML = '';

            for (let i = 1; i <= totalPages; i++) {
                if (deletedPages.has(i)) continue;

                const wrapper = document.createElement('div');
                wrapper.className = `p-2.5 bg-slate-900 hover:bg-slate-800 rounded-xl cursor-pointer border border-slate-850 flex items-center gap-3 transition ${i === currentPageNum ? 'border-blue-500 bg-slate-800' : ''}`;
                wrapper.id = `thumb-page-${i}`;
                wrapper.onclick = () => {
                    saveCurrentPageObjects();
                    currentPageNum = i;
                    
                    if (viewMode === 'single') {
                        renderAllPages();
                    } else {
                        // Jika mode scroll, langsung gulirkan layar ke elemen target
                        const el = document.getElementById(`page-wrapper-${i}`);
                        scrollPageIntoView(el);
                        setActivePage(i);
                    }
                };

                const num = document.createElement('span');
                num.className = 'w-6 h-6 rounded-lg bg-slate-950 text-[10px] font-bold flex items-center justify-center text-slate-400 border border-slate-800';
                num.innerText = i;

                const label = document.createElement('div');
                label.className = 'flex-1 min-w-0';
                label.innerHTML = `
                    <p class="text-xs font-semibold text-slate-200">Halaman ${i}</p>
                    <p class="text-[9px] text-slate-500">Putar: ${rotationStates[i] || 0}°</p>
                `;

                wrapper.appendChild(num);
                wrapper.appendChild(label);
                container.appendChild(wrapper);
            }
        }

        function updateSidebarHighlight() {
            for (let i = 1; i <= totalPages; i++) {
                const el = document.getElementById(`thumb-page-${i}`);
                if (el) {
                    if (i === currentPageNum) {
                        el.classList.add('border-blue-500', 'bg-slate-800');
                    } else {
                        el.classList.remove('border-blue-500', 'bg-slate-800');
                    }
                }
            }
        }

        // TOGGLE VIEW MODE: SINGLE PAGE VS SCROLL VERTIKAL
        const btnViewSingle = document.getElementById('btn-view-single');
        const btnViewScroll = document.getElementById('btn-view-scroll');

        btnViewSingle.addEventListener('click', () => {
            if (viewMode === 'single') return;
            viewMode = 'single';
            btnViewSingle.classList.add('bg-blue-600', 'text-white', 'shadow-md');
            btnViewSingle.classList.remove('text-slate-400');
            btnViewScroll.classList.remove('bg-blue-600', 'text-white', 'shadow-md');
            btnViewScroll.classList.add('text-slate-400');
            editorViewport.onscroll = null; // Matikan scroll spy
            renderAllPages();
        });

        btnViewScroll.addEventListener('click', () => {
            if (viewMode === 'scroll') return;
            viewMode = 'scroll';
            btnViewScroll.classList.add('bg-blue-600', 'text-white', 'shadow-md');
            btnViewScroll.classList.remove('text-slate-400');
            btnViewSingle.classList.remove('bg-blue-600', 'text-white', 'shadow-md');
            btnViewSingle.classList.add('text-slate-400');
            renderAllPages();
        });

        // PENGELOLA ALAT (ACTIVE TOOL CONTROLLER)
        const tools = {
            'cropmove': document.getElementById('tool-cropmove'),
            'select': document.getElementById('tool-select'),
            'pen': document.getElementById('tool-pen'),
            'highlighter': document.getElementById('tool-highlighter'),
            'text': document.getElementById('tool-text'),
            'edit-text': document.getElementById('tool-edit-text'),
            'shapes': document.getElementById('tool-shapes'),
            'whiteout': document.getElementById('tool-whiteout'),
            'signature': document.getElementById('tool-signature')
        };

        // Nama tool bentuk yang harus menyalakan highlight tombol dropdown "shapes"
        const SHAPE_TOOL_NAMES = ['rect', 'oval', 'circle', 'line'];

        Object.keys(tools).forEach(toolName => {
            if (toolName === 'shapes') return; // Tombol ini cuma pemicu dropdown, bukan tool langsung
            if (toolName === 'signature') return; // Tombol ini membuka modal langsung, ditangani terpisah di bawah
            tools[toolName].addEventListener('click', () => {
                setActiveTool(toolName);
            });
        });

        // FIX: sebelumnya tombol Tanda Tangan ikut masuk ke binding generik di
        // atas (cuma memanggil setActiveTool('signature')), padahal tidak ada
        // satupun cabang di applyToolStateToCanvas yang menangani mode
        // 'signature' -- jadi klik tombolnya tidak berbuat apa-apa sama sekali,
        // modal tanda tangan tidak pernah terbuka. Sekarang tombol ini langsung
        // membuka modal saat diklik, seperti Whiteout/Crop yang sifatnya aksi
        // langsung, bukan mode yang menunggu klik di kanvas.
        document.getElementById('tool-signature').addEventListener('click', () => {
            openSignatureModal();
        });

        function setActiveTool(toolName) {
            activeTool = toolName;

            // Kelompokkan rect/oval/circle/line agar menyalakan highlight tombol dropdown "shapes"
            const displayGroup = SHAPE_TOOL_NAMES.includes(toolName) ? 'shapes' : toolName;

            Object.keys(tools).forEach(name => {
                if (name === displayGroup) {
                    tools[name].classList.add('active');
                } else {
                    tools[name].classList.remove('active');
                }
            });

            // Terapkan ke semua canvas halaman agar responsif saat di-scroll
            Object.values(activeFabricCanvases).forEach(c => applyToolStateToCanvas(c));
        }

        function applyToolState() {
            if (fCanvas) {
                applyToolStateToCanvas(fCanvas);
            }
        }

        function applyToolStateToCanvas(canvasObj) {
            if (!canvasObj) return;

            // Reset Default State
            canvasObj.isDrawingMode = false;
            canvasObj.selection = false;
            canvasObj.off('mouse:down');
            canvasObj.off('mouse:move');
            canvasObj.off('mouse:up');
            
            canvasObj.forEachObject(obj => {
                obj.selectable = false;
                obj.hoverCursor = 'default';
            });

            if (activeTool === 'select') {
                canvasObj.selection = true;
                canvasObj.forEachObject(obj => {
                    obj.selectable = true;
                    obj.hoverCursor = 'move';
                });
            } else if (activeTool === 'pen' || activeTool === 'highlighter') {
                canvasObj.isDrawingMode = true;
                const brush = canvasObj.freeDrawingBrush;

                if (activeTool === 'highlighter') {
                    // Stabilo: lebih lebar dari pen (3x), warna transparan, ujung
                    // goresan rata (square) supaya terasa seperti marker, bukan pena.
                    brush.color = hexToRgbA(globalColor, 0.4);
                    brush.width = parseInt(strokeWidth) * 3;
                    brush.strokeLineCap = 'square';
                    brush.strokeLineJoin = 'round';
                } else {
                    // Pen: warna solid, ketebalan sesuai pilihan, ujung bulat normal.
                    brush.color = globalColor;
                    brush.width = parseInt(strokeWidth);
                    brush.strokeLineCap = 'round';
                    brush.strokeLineJoin = 'round';
                }
            } else if (activeTool === 'text') {
                canvasObj.on('mouse:down', function(opt) {
                    if (activeTool !== 'text') return;
                    const pointer = canvasObj.getPointer(opt.e);

                    const textObj = new fabric.IText('Ketik Teks Baru', {
                        left: pointer.x,
                        top: pointer.y,
                        fontFamily: selectedFontFamily,
                        fill: globalColor,
                        fontSize: parseInt(fontSize),
                        fontWeight: 'bold'
                    });
                    
                    canvasObj.add(textObj);
                    canvasObj.setActiveObject(textObj);
                    setActiveTool('select');
                });
            } else if (activeTool === 'edit-text') {
                canvasObj.on('mouse:down', async function(opt) {
                    if (activeTool !== 'edit-text') return;

                    const wrapper = canvasObj.getElement().closest('.pdf-page-container');
                    const pageNum = parseInt(wrapper.dataset.pageNum);
                    const pointer = canvasObj.getPointer(opt.e);

                    const lines = await getPageTextLines(pageNum);
                    if (lines.length === 0) {
                        showToast("Tidak ada teks yang terdeteksi di halaman ini (mungkin hasil scan/gambar).", "error");
                        return;
                    }

                    const found = findTextLineAtPoint(lines, pageNum, pointer.x, pointer.y);
                    if (!found) return; // Klik di area kosong, tidak ada baris teks di situ

                    // Kalau tool sudah berpindah selagi menunggu getPageTextLines (async),
                    // batalkan supaya tidak salah menempatkan kotak teks.
                    if (activeTool !== 'edit-text') return;

                    const { index, line } = found;

                    // Tandai baris ini sudah dikonversi supaya tidak dobel kalau diklik lagi
                    if (!convertedTextLines[pageNum]) convertedTextLines[pageNum] = new Set();
                    convertedTextLines[pageNum].add(index);

                    // Tutup teks asli dengan kotak putih (sedikit padding biar rapi menutupi)
                    const PAD = 1.5;
                    const coverRect = new fabric.Rect({
                        left: line.left - PAD,
                        top: line.top - PAD,
                        width: line.width + PAD * 2,
                        height: line.height + PAD * 2,
                        fill: '#ffffff',
                        selectable: false
                    });
                    canvasObj.add(coverRect);

                    // Ganti dengan kotak teks yang bisa diedit, terisi teks aslinya
                    const textObj = new fabric.IText(line.text, {
                        left: line.left,
                        top: line.top,
                        fontFamily: selectedFontFamily,
                        fill: '#000000',
                        fontSize: Math.max(8, Math.round(line.height))
                    });

                    canvasObj.add(textObj);
                    canvasObj.setActiveObject(textObj);
                    // Langsung masuk mode edit dengan semua teks terpilih, supaya
                    // user bisa langsung ketik untuk mengganti isinya.
                    textObj.enterEditing();
                    textObj.selectAll();
                    canvasObj.renderAll();

                    saveStateToHistory(pageNum, canvasObj);
                    showToast("Baris teks siap diedit. Klik baris lain untuk edit berikutnya.", "success");
                    // Sengaja TIDAK auto-pindah ke tool 'select', supaya user bisa
                    // langsung klik baris teks lain berikutnya di halaman yang sama.
                });
            } else if (SHAPE_TOOL_NAMES.includes(activeTool)) {
                let shape, isDown, origX, origY, shapeType;

                canvasObj.on('mouse:down', function(opt) {
                    if (!SHAPE_TOOL_NAMES.includes(activeTool)) return;
                    isDown = true;
                    shapeType = activeTool;
                    const pointer = canvasObj.getPointer(opt.e);
                    origX = pointer.x;
                    origY = pointer.y;
                    const strokeW = parseInt(strokeWidth) || 4;
                    const commonProps = {
                        stroke: globalColor,
                        strokeWidth: strokeW,
                        fill: 'transparent',
                        selectable: false,
                        originX: 'left',
                        originY: 'top'
                    };

                    if (shapeType === 'rect') {
                        shape = new fabric.Rect({ ...commonProps, left: origX, top: origY, width: 0, height: 0 });
                    } else if (shapeType === 'oval') {
                        shape = new fabric.Ellipse({ ...commonProps, left: origX, top: origY, rx: 0, ry: 0 });
                    } else if (shapeType === 'circle') {
                        shape = new fabric.Circle({ ...commonProps, left: origX, top: origY, radius: 0 });
                    } else if (shapeType === 'line') {
                        shape = new fabric.Line([origX, origY, origX, origY], {
                            stroke: globalColor,
                            strokeWidth: strokeW,
                            selectable: false
                        });
                    }
                    canvasObj.add(shape);
                });

                canvasObj.on('mouse:move', function(opt) {
                    if (!isDown || !shape) return;
                    const pointer = canvasObj.getPointer(opt.e);
                    const w = pointer.x - origX;
                    const h = pointer.y - origY;

                    if (shapeType === 'rect') {
                        shape.set({
                            left: Math.min(origX, pointer.x),
                            top: Math.min(origY, pointer.y),
                            width: Math.abs(w),
                            height: Math.abs(h)
                        });
                    } else if (shapeType === 'oval') {
                        shape.set({
                            left: Math.min(origX, pointer.x),
                            top: Math.min(origY, pointer.y),
                            rx: Math.abs(w) / 2,
                            ry: Math.abs(h) / 2
                        });
                    } else if (shapeType === 'circle') {
                        const r = Math.max(Math.abs(w), Math.abs(h)) / 2;
                        shape.set({
                            left: Math.min(origX, pointer.x),
                            top: Math.min(origY, pointer.y),
                            radius: r
                        });
                    } else if (shapeType === 'line') {
                        shape.set({ x2: pointer.x, y2: pointer.y });
                    }
                    canvasObj.renderAll();
                });

                canvasObj.on('mouse:up', function() {
                    if (!isDown) return;
                    isDown = false;

                    if (shape) {
                        const tooSmall = shapeType === 'line'
                            ? (Math.abs(shape.x2 - shape.x1) < 5 && Math.abs(shape.y2 - shape.y1) < 5)
                            : (shape.width < 5 && shape.height < 5 && (shape.radius || 0) < 5 && (shape.rx || 0) < 5);

                        if (tooSmall) {
                            canvasObj.remove(shape);
                        } else {
                            shape.set({ selectable: true, hoverCursor: 'move' });
                            shape.setCoords();
                            canvasObj.setActiveObject(shape);
                            saveStateToHistory(currentPageNum, canvasObj);
                        }
                    }
                    setActiveTool('select');
                });
            } else if (activeTool === 'whiteout') {
                canvasObj.on('mouse:down', function(opt) {
                    if (activeTool !== 'whiteout') return;
                    const pointer = canvasObj.getPointer(opt.e);
                    // FIX: sebelumnya border putus-putus (stroke + strokeDashArray)
                    // dipakai sebagai indikator visual di editor, TAPI border ini
                    // ikut ter-bake ke dalam PNG saat export (lihat proses export),
                    // jadi ninggalin garis putus-putus tipis di sekitar area yang
                    // ditutup -- terutama kelihatan kalau dipakai menutup watermark
                    // di atas latar putih hasil scan. Solusinya: border dibuat
                    // sebagai properti TERPISAH yang ditandai `excludeFromExport`,
                    // lalu proses export mengosongkan stroke-nya sebelum di-render
                    // ke PNG (lihat perubahan di bagian export).
                    const whiteBlock = new fabric.Rect({
                        left: pointer.x,
                        top: pointer.y,
                        width: 120,
                        height: 40,
                        fill: '#ffffff',
                        stroke: '#e2e8f0',
                        strokeWidth: 1,
                        strokeDashArray: [4, 4],
                        excludeStrokeFromExport: true
                    });
                    canvasObj.add(whiteBlock);
                    canvasObj.setActiveObject(whiteBlock);
                    setActiveTool('select');
                    showToast("Bidang penghapus putih dibuat! Geser di atas teks asli untuk menghapusnya.", "info");
                });
            } else if (activeTool === 'cropmove') {
                let rect, isDown, origX, origY;
                
                canvasObj.on('mouse:down', function(o) {
                    if (activeTool !== 'cropmove') return;
                    isDown = true;
                    const pointer = canvasObj.getPointer(o.e);
                    origX = pointer.x;
                    origY = pointer.y;
                    
                    rect = new fabric.Rect({
                        left: origX,
                        top: origY,
                        width: 0,
                        height: 0,
                        fill: 'rgba(59, 130, 246, 0.2)',
                        stroke: '#3b82f6',
                        strokeWidth: 2,
                        strokeDashArray: [5, 5],
                        selectable: false
                    });
                    canvasObj.add(rect);
                });

                canvasObj.on('mouse:move', function(o) {
                    if (!isDown || activeTool !== 'cropmove') return;
                    const pointer = canvasObj.getPointer(o.e);
                    
                    if (origX > pointer.x) {
                        rect.set({ left: Math.abs(pointer.x) });
                    }
                    if (origY > pointer.y) {
                        rect.set({ top: Math.abs(pointer.y) });
                    }
                    
                    rect.set({ width: Math.abs(origX - pointer.x) });
                    rect.set({ height: Math.abs(origY - pointer.y) });
                    canvasObj.renderAll();
                });

                canvasObj.on('mouse:up', async function() {
                    if (!isDown || activeTool !== 'cropmove') return;
                    isDown = false;
                    
                    const width = rect.width;
                    const height = rect.height;
                    const left = rect.left;
                    const top = rect.top;
                    
                    canvasObj.remove(rect);

                    if (width < 10 || height < 10) {
                        showToast("Area seleksi terlalu kecil.", "error");
                        setActiveTool('select');
                        return;
                    }

                    // Ambil nomor halaman & referensi pdf.js asli untuk render ulang
                    const wrapper = canvasObj.getElement().closest('.pdf-page-container');
                    const pageNum = parseInt(wrapper.dataset.pageNum);
                    const page = pdfPageProxies[pageNum];

                    if (!page) {
                        showToast("Gagal memproses crop: halaman tidak ditemukan.", "error");
                        setActiveTool('select');
                        return;
                    }

                    showToast("Memproses potongan gambar...", "info");

                    // FIX BURAM (cara yang lebih tepat): daripada mengambil sampel dari
                    // canvas layar yang resolusinya dibatasi (RENDER_DPR, demi performa
                    // & ukuran file saat export), kita render ULANG langsung dari data
                    // PDF asli KHUSUS untuk area yang di-crop saja, pada resolusi jauh
                    // lebih tinggi. Karena cuma area kecil yang dirender ulang (bukan
                    // seluruh halaman), ini tetap aman untuk memori & hasilnya jauh
                    // lebih tajam karena diambil langsung dari data vektor PDF asli,
                    // bukan upscale dari bitmap yang resolusinya sudah terbatas.
                    const DESIRED_SAMPLE = 4;
                    const MAX_CROP_MEGAPIXELS = 16_000_000; // batas aman memori
                    const rawPixels = width * height * DESIRED_SAMPLE * DESIRED_SAMPLE;
                    const cropSample = rawPixels > MAX_CROP_MEGAPIXELS
                        ? Math.max(1, Math.floor(Math.sqrt(MAX_CROP_MEGAPIXELS / (width * height))))
                        : DESIRED_SAMPLE;

                    const rot = rotationStates[pageNum] || 0;
                    const highViewport = page.getViewport({ scale: currentZoom * cropSample, rotation: rot });

                    // Posisi & ukuran area crop dalam ruang resolusi tinggi tsb
                    const sx = Math.round(left * cropSample);
                    const sy = Math.round(top * cropSample);
                    const sw = Math.round(width * cropSample);
                    const sh = Math.round(height * cropSample);

                    // Canvas sementara HANYA seukuran area crop (bukan seluruh
                    // halaman!), digeser lewat parameter `transform` supaya bagian
                    // yang diinginkan jatuh tepat di titik (0,0).
                    const tempCanvas = document.createElement('canvas');
                    tempCanvas.width = sw;
                    tempCanvas.height = sh;
                    const tempCtx = tempCanvas.getContext('2d');
                    tempCtx.imageSmoothingEnabled = false;

                    try {
                        await page.render({
                            canvasContext: tempCtx,
                            viewport: highViewport,
                            transform: [1, 0, 0, 1, -sx, -sy]
                        }).promise;
                    } catch (err) {
                        console.error(err);
                        showToast("Gagal merender area crop.", "error");
                        setActiveTool('select');
                        return;
                    }

                    const croppedDataUrl = tempCanvas.toDataURL();

                    const coverRect = new fabric.Rect({
                        left: left,
                        top: top,
                        width: width,
                        height: height,
                        fill: '#ffffff',
                        selectable: false
                    });
                    canvasObj.add(coverRect);

                    fabric.Image.fromURL(croppedDataUrl, function(imgObj) {
                        imgObj.set({
                            left: left,
                            top: top,
                            // Gambar disimpan pada resolusi tinggi (sw x sh piksel),
                            // di-scale turun ke ukuran tampilan CSS aslinya (width x
                            // height) berdasarkan dimensi HASIL PEMBULATAN, supaya
                            // ukurannya presisi walau ada pembulatan sebelumnya.
                            scaleX: width / sw,
                            scaleY: height / sh,
                            selectable: true,
                            hoverCursor: 'move',
                            borderDashArray: [3, 3],
                            borderColor: '#eab308'
                        });
                        canvasObj.add(imgObj);
                        canvasObj.setActiveObject(imgObj);
                        
                        saveStateToHistory(pageNum, canvasObj);
                        setActiveTool('select');
                        showToast("Elemen asli berhasil dipotong dan bisa digeser!", "success");
                    });
                });
            }
        }

        // SISIPKAN SIMBOL KUSTOM
        function insertSymbol(symbol, defaultColor) {
            if (!fCanvas) {
                showToast("Buka atau pilih halaman PDF terlebih dahulu.", "error");
                return;
            }

            const size = parseInt(fontSize) * 1.5;
            const symObj = new fabric.Text(symbol, {
                left: 100,
                top: 100,
                fontSize: size,
                fill: defaultColor,
                fontWeight: 'bold',
                fontFamily: 'sans-serif'
            });

            fCanvas.add(symObj);
            fCanvas.setActiveObject(symObj);
            saveStateToHistory(currentPageNum, fCanvas);
            setActiveTool('select');
            showToast("Simbol berhasil ditempel! Anda bebas menggesernya.", "success");
        }

        // Pengatur Warna Global & Ukuran Line
        function setGlobalColor(color) {
            globalColor = color;
            document.getElementById('color-indicator').style.backgroundColor = color;
            
            if (fCanvas && fCanvas.getActiveObject()) {
                const activeObj = fCanvas.getActiveObject();
                if (activeObj.type === 'i-text' || activeObj.type === 'text') {
                    activeObj.set({ fill: color });
                } else {
                    activeObj.set({ stroke: color });
                }
                fCanvas.renderAll();
                saveStateToHistory(currentPageNum, fCanvas);
            }

            // FIX: kalau tool gambar (pen/highlighter) sedang aktif, warna kuas
            // harus langsung ikut berubah di SEMUA canvas halaman, bukan cuma
            // menunggu ada objek yang dipilih (karena saat menggambar tidak ada
            // objek yang "selected").
            if (activeTool === 'pen' || activeTool === 'highlighter') {
                const brushColor = activeTool === 'highlighter' ? hexToRgbA(color, 0.4) : color;
                Object.values(activeFabricCanvases).forEach(c => {
                    if (c.freeDrawingBrush) {
                        c.freeDrawingBrush.color = brushColor;
                    }
                });
            }
        }

        document.getElementById('font-family-selector').addEventListener('change', (e) => {
            selectedFontFamily = e.target.value;
            if (fCanvas && fCanvas.getActiveObject()) {
                const activeObj = fCanvas.getActiveObject();
                if (activeObj.type === 'i-text' || activeObj.type === 'text') {
                    activeObj.set({ fontFamily: selectedFontFamily });
                    fCanvas.renderAll();
                    saveStateToHistory(currentPageNum, fCanvas);
                }
            }
        });

        document.getElementById('stroke-width').addEventListener('change', (e) => {
            strokeWidth = e.target.value;

            // Update kuas pen/highlighter yang sedang aktif di semua canvas
            Object.values(activeFabricCanvases).forEach(c => {
                if (c.freeDrawingBrush) {
                    c.freeDrawingBrush.width = activeTool === 'highlighter'
                        ? parseInt(strokeWidth) * 3
                        : parseInt(strokeWidth);
                }
            });

            // Kalau ada objek bentuk/garis yang sedang dipilih, update ketebalannya juga
            if (fCanvas && fCanvas.getActiveObject()) {
                const activeObj = fCanvas.getActiveObject();
                if (activeObj.type !== 'i-text' && activeObj.type !== 'text') {
                    activeObj.set({ strokeWidth: parseInt(strokeWidth) });
                    fCanvas.renderAll();
                    saveStateToHistory(currentPageNum, fCanvas);
                }
            }
        });

        document.getElementById('font-size').addEventListener('change', (e) => {
            fontSize = e.target.value;

            // Kalau ada teks yang sedang dipilih, update ukurannya langsung
            if (fCanvas && fCanvas.getActiveObject()) {
                const activeObj = fCanvas.getActiveObject();
                if (activeObj.type === 'i-text' || activeObj.type === 'text') {
                    activeObj.set({ fontSize: parseInt(fontSize) });
                    fCanvas.renderAll();
                    saveStateToHistory(currentPageNum, fCanvas);
                }
            }
        });

        // Hapus Objek Terpilih (menangani single object maupun multi-select)
        function deleteActiveObject(canvas) {
            const activeObj = canvas.getActiveObject();
            if (!activeObj) return false;

            if (activeObj.type === 'activeSelection') {
                // FIX: canvas.remove(activeSelection) TIDAK benar-benar menghapus
                // objek di dalamnya -- cuma membuang wrapper seleksinya, jadi
                // objek asli tetap ada di canvas.getObjects() / toJSON() dan
                // muncul lagi saat export. Solusinya: bongkar dulu grup-nya,
                // baru hapus tiap objek asli satu per satu.
                const objects = activeObj.getObjects();
                canvas.discardActiveObject();
                objects.forEach(obj => canvas.remove(obj));
            } else {
                canvas.remove(activeObj);
            }
            return true;
        }

        document.getElementById('btn-delete-selected').addEventListener('click', () => {
            if (!fCanvas) return;
            if (deleteActiveObject(fCanvas)) {
                showToast("Objek terhapus!", "info");
            } else {
                showToast("Pilih objek terlebih dahulu untuk dihapus.", "error");
            }
        });

        // Hubungkan Tombol Undo dan Redo UI
        document.getElementById('btn-undo').addEventListener('click', triggerUndo);
        document.getElementById('btn-redo').addEventListener('click', triggerRedo);

        // SHORTCUTS KEYBOARD: UNDO, REDO & ARROW KEYS NUDGE
        window.addEventListener('keydown', (e) => {
            if (!fCanvas) return;
            const activeObj = fCanvas.getActiveObject();
            
            const isCtrlOrCmd = e.ctrlKey || e.metaKey;
            
            if (isCtrlOrCmd) {
                if (e.key.toLowerCase() === 'z') {
                    e.preventDefault();
                    triggerUndo();
                    return;
                } else if (e.key.toLowerCase() === 'y') {
                    e.preventDefault();
                    triggerRedo();
                    return;
                }
            }
            
            if (activeObj && !activeObj.isEditing) {
                const moveAmount = e.shiftKey ? 10 : 1;
                
                if (e.key === 'ArrowUp') {
                    activeObj.set('top', activeObj.top - moveAmount);
                    e.preventDefault();
                } else if (e.key === 'ArrowDown') {
                    activeObj.set('top', activeObj.top + moveAmount);
                    e.preventDefault();
                } else if (e.key === 'ArrowLeft') {
                    activeObj.set('left', activeObj.left - moveAmount);
                    e.preventDefault();
                } else if (e.key === 'ArrowRight') {
                    activeObj.set('left', activeObj.left + moveAmount);
                    e.preventDefault();
                } else if (e.key === 'Delete' || e.key === 'Backspace') {
                    // FIX: pakai helper deleteActiveObject supaya multi-seleksi
                    // (ActiveSelection) juga benar-benar terhapus dari canvas,
                    // bukan cuma hilang secara visual.
                    deleteActiveObject(fCanvas);
                    showToast("Objek terhapus!", "info");
                }
                
                fCanvas.renderAll();
                saveCurrentPageObjects();
                saveStateToHistory(currentPageNum, fCanvas);
            }
        });

        // NAVIGASI ZOOM & HALAMAN
        document.getElementById('btn-zoom-in').addEventListener('click', () => {
            if (currentZoom < 3.0) {
                const oldZoom = currentZoom;
                saveCurrentPageObjects();
                currentZoom += 0.2;
                // FIX: sesuaikan posisi & ukuran semua objek editan sebanding
                // dengan rasio zoom baru, supaya tetap menempel di PDF-nya.
                rescaleAllPageObjects(currentZoom / oldZoom);
                document.getElementById('zoom-percent').innerText = `${Math.round(currentZoom * 100)}%`;
                renderAllPages();
            }
        });

        document.getElementById('btn-zoom-out').addEventListener('click', () => {
            if (currentZoom > 0.5) {
                const oldZoom = currentZoom;
                saveCurrentPageObjects();
                currentZoom -= 0.2;
                // FIX: sesuaikan posisi & ukuran semua objek editan sebanding
                // dengan rasio zoom baru, supaya tetap menempel di PDF-nya.
                rescaleAllPageObjects(currentZoom / oldZoom);
                document.getElementById('zoom-percent').innerText = `${Math.round(currentZoom * 100)}%`;
                renderAllPages();
            }
        });

        document.getElementById('btn-prev-page').addEventListener('click', () => {
            if (currentPageNum > 1) {
                saveCurrentPageObjects();
                let prev = currentPageNum - 1;
                while (prev > 1 && deletedPages.has(prev)) {
                    prev--;
                }
                if (viewMode === 'single') {
                    currentPageNum = prev;
                    renderAllPages();
                } else {
                    const el = document.getElementById('page-wrapper-' + prev);
                    scrollPageIntoView(el);
                    setActivePage(prev);
                }
            }
        });

        document.getElementById('btn-next-page').addEventListener('click', () => {
            if (currentPageNum < totalPages) {
                saveCurrentPageObjects();
                let next = currentPageNum + 1;
                while (next < totalPages && deletedPages.has(next)) {
                    next++;
                }
                if (viewMode === 'single') {
                    currentPageNum = next;
                    renderAllPages();
                } else {
                    const el = document.getElementById('page-wrapper-' + next);
                    scrollPageIntoView(el);
                    setActivePage(next);
                }
            }
        });

        // AKSI PUTAR DAN HAPUS HALAMAN
        document.getElementById('btn-rotate-page').addEventListener('click', () => {
            if (!pdfDocInstance) return;

            saveCurrentPageObjects(); // Pastikan editan terbaru tersimpan dulu

            const pageNum = currentPageNum;
            const oldRot = rotationStates[pageNum] || 0;
            const newRot = (oldRot + 90) % 360;

            // FIX: putar & pindahkan posisi semua objek editan di halaman ini
            // supaya tetap menempel pas, sebelum halaman di-render ulang di
            // orientasi barunya.
            const page = pdfPageProxies[pageNum];
            const oldViewport = pdfPageViewports[pageNum];
            if (page && oldViewport) {
                const newViewport = page.getViewport({ scale: currentZoom, rotation: newRot });
                rotateAllObjectsOnPage(pageNum, oldViewport, newViewport, 90);
            }

            rotationStates[pageNum] = newRot;
            
            generateSidebarThumbnails();
            renderAllPages();
            showToast("Halaman diputar 90°", "success");
        });

        document.getElementById('btn-delete-page').addEventListener('click', () => {
            if (!pdfDocInstance) return;
            if (confirm(`Apakah Anda yakin ingin menghapus Halaman ${currentPageNum}?`)) {
                deletedPages.add(currentPageNum);
                generateSidebarThumbnails();
                renderAllPages();
                showToast("Halaman berhasil dibuang dari draft", "info");
            }
        });

        // LUKIS TANDA TANGAN (SIGNATURE MODAL EVENTS)
        function openSignatureModal() {
            document.getElementById('signature-modal').classList.remove('hidden');
            sigPad.width = sigPad.offsetWidth;
            sigPad.height = sigPad.offsetHeight;
            ctxSig.strokeStyle = '#000000';
            ctxSig.lineWidth = 3;
            ctxSig.lineCap = 'round';
            ctxSig.lineJoin = 'round';
            clearSignaturePad();
        }

        function closeSignatureModal() {
            document.getElementById('signature-modal').classList.add('hidden');
            setActiveTool('select');
        }

        function clearSignaturePad() {
            ctxSig.fillStyle = '#ffffff';
            ctxSig.fillRect(0, 0, sigPad.width, sigPad.height);
        }

        sigPad.addEventListener('mousedown', (e) => {
            drawingSig = true;
            const rect = sigPad.getBoundingClientRect();
            ctxSig.beginPath();
            ctxSig.moveTo(e.clientX - rect.left, e.clientY - rect.top);
        });

        sigPad.addEventListener('mousemove', (e) => {
            if (!drawingSig) return;
            const rect = sigPad.getBoundingClientRect();
            ctxSig.lineTo(e.clientX - rect.left, e.clientY - rect.top);
            ctxSig.stroke();
        });

        sigPad.addEventListener('mouseup', () => drawingSig = false);
        sigPad.addEventListener('mouseout', () => drawingSig = false);

        // Touch support tanda tangan
        sigPad.addEventListener('touchstart', (e) => {
            const touch = e.touches[0];
            const rect = sigPad.getBoundingClientRect();
            drawingSig = true;
            ctxSig.beginPath();
            ctxSig.moveTo(touch.clientX - rect.left, touch.clientY - rect.top);
            e.preventDefault();
        });
        sigPad.addEventListener('touchmove', (e) => {
            if (!drawingSig) return;
            const touch = e.touches[0];
            const rect = sigPad.getBoundingClientRect();
            ctxSig.lineTo(touch.clientX - rect.left, touch.clientY - rect.top);
            ctxSig.stroke();
            e.preventDefault();
        });

        function saveSignature() {
            const dataUrl = sigPad.toDataURL('image/png');
            
            fabric.Image.fromURL(dataUrl, (img) => {
                img.set({
                    left: 50,
                    top: 50,
                    scaleX: 0.6,
                    scaleY: 0.6
                });
                fCanvas.add(img);
                fCanvas.setActiveObject(img);
                saveCurrentPageObjects();
                saveStateToHistory(currentPageNum, fCanvas);
                setActiveTool('select');
                showToast("Tanda tangan ditambahkan! Silakan geser atau atur ukurannya.", "success");
            });

            closeSignatureModal();
        }

        // FITUR SISIPKAN HALAMAN KOSONG (INSERT BLANK PAGE)
        document.getElementById('btn-add-blank').addEventListener('click', async () => {
            if (!pdfDataBytes) {
                const newDoc = await PDFLib.PDFDocument.create();
                newDoc.addPage([595, 842]);
                pdfDataBytes = await newDoc.save();
                await loadPdfDocument();
                return;
            }

            saveCurrentPageObjects();
            showToast("Menyisipkan halaman kosong setelah halaman ini...", "info");

            try {
                const libDoc = await PDFLib.PDFDocument.load(pdfDataBytes);
                libDoc.insertPage(currentPageNum, [595, 842]); 
                
                pdfDataBytes = await libDoc.save();
                
                const loadingTask = pdfjsLib.getDocument({ data: pdfDataBytes.slice() });
                pdfDocInstance = await loadingTask.promise;
                totalPages = pdfDocInstance.numPages;
                
                currentPageNum++;
                generateSidebarThumbnails();
                await renderAllPages();
                showToast("Halaman kosong berhasil disisipkan!", "success");
            } catch (err) {
                console.error(err);
                showToast("Gagal menyisipkan halaman kosong.", "error");
            }
        });

        // FITUR PISAHKAN PDF (SPLIT PDF SYSTEM)
        document.getElementById('btn-split').addEventListener('click', async () => {
            if (!pdfDataBytes) return;
            const input = prompt(`Masukkan rentang halaman yang ingin dipisah (Contoh: "1-2" atau "3-5" atau "2"):`, `${currentPageNum}`);
            if (!input) return;

            showToast("Memproses pemisahan berkas PDF...", "info");
            try {
                const parts = input.split('-');
                let start = parseInt(parts[0]);
                let end = parts[1] ? parseInt(parts[1]) : start;

                if (isNaN(start) || start < 1 || end > totalPages || start > end) {
                    showToast("Rentang halaman tidak valid.", "error");
                    return;
                }

                const srcDoc = await PDFLib.PDFDocument.load(pdfDataBytes);
                const subDoc = await PDFLib.PDFDocument.create();

                const pagesToCopy = [];
                for (let i = start; i <= end; i++) {
                    pagesToCopy.push(i - 1);
                }

                const copiedPages = await subDoc.copyPages(srcDoc, pagesToCopy);
                copiedPages.forEach(p => subDoc.addPage(p));

                const subBytes = await subDoc.save();
                
                const saved = await saveOrDownloadFile(subBytes, `split_halaman_${start}_sampai_${end}.pdf`);
                if (saved) showToast("PDF berhasil dipisahkan dan diunduh!", "success");
            } catch (err) {
                console.error(err);
                showToast("Proses pemisahan PDF gagal.", "error");
            }
        });


        // ================== FITUR: GAMBAR KE PDF ==================
        let image2pdfFiles = []; // { name, dataUrl }

        document.getElementById('btn-image2pdf-modal').addEventListener('click', () => {
            document.getElementById('image2pdf-modal').classList.remove('hidden');
        });
        document.getElementById('btn-close-image2pdf').addEventListener('click', closeImage2PdfModal);
        document.getElementById('btn-cancel-image2pdf').addEventListener('click', closeImage2PdfModal);

        function closeImage2PdfModal() {
            document.getElementById('image2pdf-modal').classList.add('hidden');
        }

        document.getElementById('image2pdf-file-picker').addEventListener('change', (e) => {
            const files = e.target.files;
            if (!files.length) return;

            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const reader = new FileReader();
                reader.onload = function() {
                    image2pdfFiles.push({ name: file.name, dataUrl: this.result });
                    renderImage2PdfList();
                };
                reader.readAsDataURL(file);
            }
        });

        function renderImage2PdfList() {
            const container = document.getElementById('image2pdf-files-list');

            if (image2pdfFiles.length === 0) {
                container.innerHTML = `
                    <div class="text-center py-8 border border-dashed border-slate-800 rounded-xl text-slate-500 text-xs">
                        Belum ada gambar terpilih.
                    </div>
                `;
                return;
            }

            container.innerHTML = '';
            image2pdfFiles.forEach((file, index) => {
                const row = document.createElement('div');
                row.className = 'flex items-center justify-between p-2 bg-slate-950 rounded-xl border border-slate-800 text-xs gap-2';
                row.innerHTML = `
                    <div class="flex items-center gap-2 truncate">
                        <img src="${file.dataUrl}" class="w-8 h-8 object-cover rounded border border-slate-800 shrink-0" />
                        <span class="bg-slate-800 text-slate-400 px-2 py-0.5 rounded-md font-mono shrink-0">${index + 1}</span>
                        <p class="truncate text-slate-300 font-semibold">${file.name}</p>
                    </div>
                    <button onclick="removeImage2PdfFile(${index})" class="text-rose-500 hover:text-rose-400 p-1 shrink-0">
                        <i data-lucide="trash-2" class="w-4 h-4"></i>
                    </button>
                `;
                container.appendChild(row);
            });

            lucide.createIcons();
        }

        window.removeImage2PdfFile = function(index) {
            image2pdfFiles.splice(index, 1);
            renderImage2PdfList();
        };

        function loadImageElement(dataUrl) {
            return new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = reject;
                img.src = dataUrl;
            });
        }

        // Ukuran halaman A4 (dalam points, 1pt = 1/72 inci) supaya konsisten
        // dengan halaman kosong lain di aplikasi ini (lihat fitur Sisipkan
        // Halaman Kosong yang juga memakai 595x842).
        const A4_WIDTH = 595;
        const A4_HEIGHT = 842;
        const A4_MARGIN = 24;

        // Preset kompresi gambar (skala resolusi maksimum + kualitas JPEG),
        // diurutkan dari paling ringan (kualitas terbaik) ke paling agresif --
        // sama persis pola-nya dengan COMPRESSION_PRESETS di fitur Kompres PDF,
        // supaya perilakunya konsisten & bisa dipakai ulang di fitur Gambar ke
        // PDF maupun Kompres Gambar.
        const IMAGE_JPEG_PRESETS = [
            { maxDim: 2000, quality: 0.85 },
            { maxDim: 1800, quality: 0.7 },
            { maxDim: 1600, quality: 0.6 },
            { maxDim: 1400, quality: 0.5 },
            { maxDim: 1200, quality: 0.45 },
            { maxDim: 1000, quality: 0.4 },
            { maxDim: 800, quality: 0.35 },
            { maxDim: 600, quality: 0.3 }
        ];
        // Untuk mode "pertahankan PNG": PNG lossless, jadi tidak ada kenop
        // kualitas -- pengecilan ukuran cuma bisa lewat penurunan resolusi.
        const IMAGE_PNG_MAXDIM_STEPS = [2000, 1600, 1300, 1000, 800, 600, 450, 300];

        // Menggambar 1 elemen <img> ke canvas pada dimensi tertentu, lalu
        // meng-encode-nya jadi JPEG (latar putih, karena JPEG tak mendukung
        // transparansi) atau PNG (mempertahankan transparansi), mengembalikan
        // bytes hasil encode.
        function encodeImageAtSize(imgEl, maxDim, quality, preserveTransparency) {
            let drawW = imgEl.naturalWidth;
            let drawH = imgEl.naturalHeight;
            if (Math.max(drawW, drawH) > maxDim) {
                const ratio = maxDim / Math.max(drawW, drawH);
                drawW = Math.round(drawW * ratio);
                drawH = Math.round(drawH * ratio);
            }

            const canvas = document.createElement('canvas');
            canvas.width = drawW;
            canvas.height = drawH;
            const ctx = canvas.getContext('2d');

            let dataUrl;
            if (preserveTransparency) {
                ctx.clearRect(0, 0, drawW, drawH);
                ctx.drawImage(imgEl, 0, 0, drawW, drawH);
                dataUrl = canvas.toDataURL('image/png');
            } else {
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, drawW, drawH);
                ctx.drawImage(imgEl, 0, 0, drawW, drawH);
                dataUrl = canvas.toDataURL('image/jpeg', quality);
            }

            return { bytes: dataURLToUint8Array(dataUrl), width: drawW, height: drawH };
        }

        document.querySelectorAll('.btn-image2pdf-option').forEach(btn => {
            btn.addEventListener('click', () => {
                const targetBytes = parseInt(btn.dataset.targetBytes, 10);
                const targetLabel = btn.dataset.targetLabel;
                convertImagesToPdf(targetBytes, targetLabel);
            });
        });

        document.getElementById('btn-image2pdf-original').addEventListener('click', () => {
            convertImagesToPdf(Infinity, 'Kualitas Asli');
        });

        // Membangun PDF gabungan dari semua gambar terpilih memakai SATU preset
        // kompresi yang sama untuk semua gambar (sama seperti compressPdfToTarget
        // memakai 1 preset untuk semua halaman), lalu mengecek total ukurannya.
        async function buildImagesPdfAtPreset(files, preset) {
            const outDoc = await PDFLib.PDFDocument.create();

            for (const file of files) {
                const imgEl = await loadImageElement(file.dataUrl);
                const { bytes: jpegBytes, width: drawW, height: drawH } = encodeImageAtSize(imgEl, preset.maxDim, preset.quality, false);
                const jpegImage = await outDoc.embedJpg(jpegBytes);

                // Hitung ukuran gambar supaya PAS (fit, tidak terpotong) di
                // dalam halaman A4 dengan margin, lalu posisikan di tengah.
                const availW = A4_WIDTH - A4_MARGIN * 2;
                const availH = A4_HEIGHT - A4_MARGIN * 2;
                const fitRatio = Math.min(availW / drawW, availH / drawH, 1);
                const finalW = drawW * fitRatio;
                const finalH = drawH * fitRatio;

                const page = outDoc.addPage([A4_WIDTH, A4_HEIGHT]);
                page.drawImage(jpegImage, {
                    x: (A4_WIDTH - finalW) / 2,
                    y: (A4_HEIGHT - finalH) / 2,
                    width: finalW,
                    height: finalH
                });
            }

            return await outDoc.save();
        }

        async function convertImagesToPdf(targetBytes, targetLabel) {
            if (image2pdfFiles.length === 0) return;

            const filesToConvert = image2pdfFiles;
            closeImage2PdfModal();
            showToast(`Mengonversi ${filesToConvert.length} gambar menjadi PDF...`, "info");

            try {
                // "Tanpa target" -> langsung pakai preset paling ringan (kualitas
                // terbaik) sekali saja, tidak perlu loop pencarian ukuran.
                const presetsToTry = targetBytes === Infinity ? [IMAGE_JPEG_PRESETS[0]] : IMAGE_JPEG_PRESETS;

                let outBytes = null;
                let achieved = targetBytes === Infinity;

                for (let p = 0; p < presetsToTry.length; p++) {
                    if (presetsToTry.length > 1) {
                        showToast(`Mengompres PDF gabungan... level ${p + 1}/${presetsToTry.length}`, "info");
                    }

                    outBytes = await buildImagesPdfAtPreset(filesToConvert, presetsToTry[p]);

                    if (targetBytes === Infinity || outBytes.byteLength <= targetBytes) {
                        achieved = true;
                        break;
                    }
                }

                image2pdfFiles = [];
                renderImage2PdfList();

                const saved = await saveOrDownloadFile(outBytes, `Gambar_ke_PDF_${Date.now()}.pdf`);
                if (saved) {
                    showToast(
                        achieved
                            ? "Gambar berhasil dikonversi menjadi PDF!"
                            : `PDF dikompres semaksimal mungkin, tapi belum sepenuhnya di bawah ${targetLabel} (${formatBytes(outBytes.byteLength)}).`,
                        achieved ? "success" : "error"
                    );
                }
            } catch (err) {
                console.error(err);
                const detail = err && err.message ? err.message : String(err);
                showToast(`Gagal mengonversi gambar ke PDF: ${detail}`, "error");
            }
        }

        // ================== FITUR: KOMPRES GAMBAR (TANPA CONVERT KE PDF) ==================
        let compressImageFiles = []; // { name, dataUrl }

        document.getElementById('btn-compress-image-modal').addEventListener('click', () => {
            document.getElementById('compress-image-modal').classList.remove('hidden');
        });
        document.getElementById('btn-close-compress-image').addEventListener('click', closeCompressImageModal);
        document.getElementById('btn-cancel-compress-image').addEventListener('click', closeCompressImageModal);

        function closeCompressImageModal() {
            document.getElementById('compress-image-modal').classList.add('hidden');
        }

        document.getElementById('compress-image-file-picker').addEventListener('change', (e) => {
            const files = e.target.files;
            if (!files.length) return;

            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const reader = new FileReader();
                reader.onload = function() {
                    compressImageFiles.push({ name: file.name, dataUrl: this.result });
                    renderCompressImageList();
                };
                reader.readAsDataURL(file);
            }
        });

        function renderCompressImageList() {
            const container = document.getElementById('compress-image-files-list');

            if (compressImageFiles.length === 0) {
                container.innerHTML = `
                    <div class="text-center py-8 border border-dashed border-slate-800 rounded-xl text-slate-500 text-xs">
                        Belum ada gambar terpilih.
                    </div>
                `;
                return;
            }

            container.innerHTML = '';
            compressImageFiles.forEach((file, index) => {
                const row = document.createElement('div');
                row.className = 'flex items-center justify-between p-2 bg-slate-950 rounded-xl border border-slate-800 text-xs gap-2';
                row.innerHTML = `
                    <div class="flex items-center gap-2 truncate">
                        <img src="${file.dataUrl}" class="w-8 h-8 object-cover rounded border border-slate-800 shrink-0" />
                        <span class="bg-slate-800 text-slate-400 px-2 py-0.5 rounded-md font-mono shrink-0">${index + 1}</span>
                        <p class="truncate text-slate-300 font-semibold">${file.name}</p>
                    </div>
                    <button onclick="removeCompressImageFile(${index})" class="text-rose-500 hover:text-rose-400 p-1 shrink-0">
                        <i data-lucide="trash-2" class="w-4 h-4"></i>
                    </button>
                `;
                container.appendChild(row);
            });

            lucide.createIcons();
        }

        window.removeCompressImageFile = function(index) {
            compressImageFiles.splice(index, 1);
            renderCompressImageList();
        };

        // Mengompres SATU gambar sampai di bawah targetBytes, mencoba preset
        // berurutan dari paling ringan ke paling agresif. Kalau preserveTransparency
        // aktif, output PNG (cuma resolusi yang diturunkan, tidak ada kenop
        // kualitas -- jadi kurang presisi mengejar target dibanding mode JPEG).
        async function compressSingleImageToTarget(dataUrl, targetBytes, preserveTransparency) {
            const imgEl = await loadImageElement(dataUrl);

            let bestBytes = null;
            const ext = preserveTransparency ? 'png' : 'jpg';

            if (preserveTransparency) {
                for (const maxDim of IMAGE_PNG_MAXDIM_STEPS) {
                    const { bytes } = encodeImageAtSize(imgEl, maxDim, null, true);
                    bestBytes = bytes;
                    if (bytes.byteLength <= targetBytes) {
                        return { bytes, ext, achieved: true };
                    }
                }
            } else {
                for (const preset of IMAGE_JPEG_PRESETS) {
                    const { bytes } = encodeImageAtSize(imgEl, preset.maxDim, preset.quality, false);
                    bestBytes = bytes;
                    if (bytes.byteLength <= targetBytes) {
                        return { bytes, ext, achieved: true };
                    }
                }
            }

            return { bytes: bestBytes, ext, achieved: false };
        }

        document.querySelectorAll('.btn-compress-image-option').forEach(btn => {
            btn.addEventListener('click', () => {
                const targetBytes = parseInt(btn.dataset.targetBytes, 10);
                const targetLabel = btn.dataset.targetLabel;
                compressImagesToTarget(targetBytes, targetLabel);
            });
        });

        async function compressImagesToTarget(targetBytes, targetLabel) {
            if (compressImageFiles.length === 0) return;

            const preserveTransparency = document.getElementById('compress-image-preserve-png').checked;
            const filesToProcess = compressImageFiles;
            closeCompressImageModal();
            showToast(`Mengompres ${filesToProcess.length} gambar...`, "info");

            try {
                const results = [];
                let anyFailedTarget = false;

                for (let idx = 0; idx < filesToProcess.length; idx++) {
                    const file = filesToProcess[idx];
                    if (filesToProcess.length > 1) {
                        showToast(`Mengompres gambar ${idx + 1}/${filesToProcess.length}...`, "info");
                    }

                    const { bytes, ext, achieved } = await compressSingleImageToTarget(file.dataUrl, targetBytes, preserveTransparency);
                    if (!achieved) anyFailedTarget = true;

                    const baseName = file.name.replace(/\.[^/.]+$/, '');
                    results.push({ bytes, filename: `${baseName}_compressed.${ext}` });
                }

                compressImageFiles = [];
                renderCompressImageList();

                if (results.length === 1) {
                    const r = results[0];
                    const isPng = r.filename.endsWith('.png');
                    const mime = isPng ? 'image/png' : 'image/jpeg';
                    const saved = await saveOrDownloadFile(r.bytes, r.filename, mime, 'Image File', [isPng ? '.png' : '.jpg']);
                    if (saved) {
                        showToast(
                            anyFailedTarget
                                ? `Gambar dikompres semaksimal mungkin, tapi belum sepenuhnya di bawah ${targetLabel}.`
                                : `Gambar berhasil dikompres di bawah ${targetLabel}!`,
                            anyFailedTarget ? "error" : "success"
                        );
                    }
                } else {
                    // Lebih dari 1 gambar -> bungkus jadi ZIP supaya tidak muncul
                    // banyak dialog Save As berurutan.
                    const saved = await saveImagesAsZip(results, `Gambar_Terkompresi_${Date.now()}.zip`);
                    if (saved) {
                        showToast(
                            anyFailedTarget
                                ? `Semua gambar dikompres (dibungkus ZIP), tapi sebagian belum sepenuhnya di bawah ${targetLabel}.`
                                : `${results.length} gambar berhasil dikompres di bawah ${targetLabel} & dibungkus jadi ZIP!`,
                            anyFailedTarget ? "error" : "success"
                        );
                    }
                }
            } catch (err) {
                console.error(err);
                const detail = err && err.message ? err.message : String(err);
                showToast(`Gagal mengompres gambar: ${detail}`, "error");
            }
        }

        // LOGIKA GABUNG BEBERAPA PDF (MERGE SYSTEM)
        let mergeFiles = [];

        // TOGGLE DROPDOWN "ALAT HALAMAN" (klik untuk buka/tutup, bukan hover)
        const pageToolsToggle = document.getElementById('btn-page-tools-toggle');
        const pageToolsDropdown = document.getElementById('page-tools-dropdown');

        pageToolsToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            pageToolsDropdown.classList.toggle('hidden');
        });

        // Tutup dropdown kalau user klik di luar area tombol/menu-nya
        document.addEventListener('click', (e) => {
            if (
                !pageToolsDropdown.classList.contains('hidden') &&
                !pageToolsDropdown.contains(e.target) &&
                e.target !== pageToolsToggle &&
                !pageToolsToggle.contains(e.target)
            ) {
                pageToolsDropdown.classList.add('hidden');
            }
        });

        // Tutup dropdown otomatis begitu salah satu opsi di dalamnya diklik
        ['btn-merge-modal', 'btn-split', 'btn-add-blank', 'btn-compress-modal', 'btn-image2pdf-modal', 'btn-compress-image-modal'].forEach(id => {
            document.getElementById(id).addEventListener('click', () => {
                pageToolsDropdown.classList.add('hidden');
            });
        });

        // TOGGLE DROPDOWN "BENTUK", "SIMBOL", & "WARNA" (klik untuk buka/tutup,
        // bukan hover) -- FIX: sebelumnya ketiganya pakai CSS group-hover, jadi
        // rawan tertutup sendiri kalau kursor sempat keluar dari area hover
        // saat bergerak menuju opsi di dalamnya (celah antara tombol & panel
        // dropdown-nya), sama seperti bug dropdown "Alat Halaman" yang sudah
        // diperbaiki sebelumnya.
        function setupSimpleDropdown(toggleId, panelId) {
            const toggle = document.getElementById(toggleId);
            const panel = document.getElementById(panelId);
            if (!toggle || !panel) return;

            toggle.addEventListener('click', (e) => {
                e.stopPropagation();
                const willOpen = panel.classList.contains('hidden');

                // Tutup dropdown sejenis lain yang mungkin masih terbuka, supaya
                // tidak ada dua dropdown kecil ini terbuka bersamaan.
                document.querySelectorAll('.simple-dropdown-panel').forEach(p => {
                    if (p !== panel) p.classList.add('hidden');
                });

                panel.classList.toggle('hidden', !willOpen);
            });

            // Tutup begitu salah satu opsi di dalam panel diklik (semua opsi di
            // dalamnya memicu aksi lewat onclick, jadi aman ditutup langsung)
            panel.addEventListener('click', () => {
                panel.classList.add('hidden');
            });
        }

        setupSimpleDropdown('tool-shapes', 'shapes-dropdown-panel');
        setupSimpleDropdown('tool-symbols', 'symbols-dropdown-panel');
        setupSimpleDropdown('color-indicator', 'color-dropdown-panel');

        // Tutup semua dropdown kecil ini kalau user klik di luar area tombol/panelnya
        document.addEventListener('click', (e) => {
            document.querySelectorAll('.simple-dropdown-panel').forEach(panel => {
                if (panel.classList.contains('hidden')) return;
                const toggle = panel.previousElementSibling;
                const clickedToggle = toggle && (e.target === toggle || toggle.contains(e.target));
                if (!panel.contains(e.target) && !clickedToggle) {
                    panel.classList.add('hidden');
                }
            });
        });

        document.getElementById('btn-merge-modal').addEventListener('click', () => {
            document.getElementById('merge-modal').classList.remove('hidden');
            renderMergeList();
        });

        document.getElementById('btn-close-merge').addEventListener('click', closeMergeModal);
        document.getElementById('btn-cancel-merge').addEventListener('click', closeMergeModal);

        function closeMergeModal() {
            document.getElementById('merge-modal').classList.add('hidden');
        }

        document.getElementById('merge-file-picker').addEventListener('change', (e) => {
            const files = e.target.files;
            if (!files.length) return;

            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const reader = new FileReader();
                reader.onload = function() {
                    mergeFiles.push({
                        name: file.name,
                        bytes: new Uint8Array(this.result)
                    });
                    renderMergeList();
                };
                reader.readAsArrayBuffer(file);
            }
        });

        function renderMergeList() {
            const container = document.getElementById('merge-files-list');
            const runBtn = document.getElementById('btn-run-merge');

            if (mergeFiles.length === 0) {
                container.innerHTML = `
                    <div class="text-center py-8 border border-dashed border-slate-800 rounded-xl text-slate-500 text-xs">
                        Belum ada file tambahan. Silakan klik tombol di bawah untuk menambah file.
                    </div>
                `;
                runBtn.setAttribute('disabled', 'true');
                return;
            }

            container.innerHTML = '';
            mergeFiles.forEach((file, index) => {
                const row = document.createElement('div');
                row.className = 'flex items-center justify-between p-3 bg-slate-950 rounded-xl border border-slate-800 text-xs';
                row.innerHTML = `
                    <div class="flex items-center gap-2 truncate">
                        <span class="bg-slate-800 text-slate-400 px-2 py-0.5 rounded-md font-mono">${index + 1}</span>
                        <p class="truncate text-slate-300 font-semibold">${file.name}</p>
                    </div>
                    <button onclick="removeMergeFile(${index})" class="text-rose-500 hover:text-rose-400 p-1">
                        <i data-lucide="trash-2" class="w-4 h-4"></i>
                    </button>
                `;
                container.appendChild(row);
            });

            lucide.createIcons();

            if (mergeFiles.length >= 2 || (pdfDataBytes && mergeFiles.length >= 1)) {
                runBtn.removeAttribute('disabled');
            } else {
                runBtn.setAttribute('disabled', 'true');
            }
        }

        window.removeMergeFile = function(index) {
            mergeFiles.splice(index, 1);
            renderMergeList();
        };

        document.getElementById('btn-run-merge').addEventListener('click', async () => {
            showToast("Menggabungkan file PDF...", "info");
            try {
                const mergedDoc = await PDFLib.PDFDocument.create();

                if (pdfDataBytes) {
                    const baseDoc = await PDFLib.PDFDocument.load(pdfDataBytes);
                    const pages = await mergedDoc.copyPages(baseDoc, baseDoc.getPageIndices());
                    pages.forEach(p => mergedDoc.addPage(p));
                }

                for (const file of mergeFiles) {
                    const docToMerge = await PDFLib.PDFDocument.load(file.bytes);
                    const pages = await mergedDoc.copyPages(docToMerge, docToMerge.getPageIndices());
                    pages.forEach(p => mergedDoc.addPage(p));
                }

                pdfDataBytes = await mergedDoc.save();
                await loadPdfDocument();
                
                closeMergeModal();
                mergeFiles = [];
                showToast("Semua berkas PDF berhasil digabungkan!", "success");
            } catch (err) {
                console.error(err);
                showToast("Proses penggabungan gagal.", "error");
            }
        });


        // Helper: ubah data URL (mis. "data:image/png;base64,....") jadi Uint8Array
        // mentah. Dipakai supaya pdf-lib menerima BYTE gambar langsung, bukan
        // string base64 yang sangat panjang -- lebih stabil untuk gambar
        // beresolusi besar (seperti hasil Crop & Move beresolusi tinggi).
        function dataURLToUint8Array(dataURL) {
            const base64 = dataURL.split(',')[1];
            const binaryString = atob(base64);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let idx = 0; idx < len; idx++) {
                bytes[idx] = binaryString.charCodeAt(idx);
            }
            return bytes;
        }

        // Membangun bytes PDF final dari dokumen asli + seluruh editan (rotasi
        // halaman & objek Fabric yang di-flatten jadi PNG per halaman). Dipakai
        // ulang oleh tombol Export MAUPUN fitur Kompres PDF, supaya keduanya
        // selalu bekerja dari hasil edit yang sama & terbaru (single source of
        // truth), tidak terpisah dua logic yang bisa saling berbeda.
        async function buildFinalPdfBytes() {
            const originalPdf = await PDFLib.PDFDocument.load(pdfDataBytes);
            const finalPdf = await PDFLib.PDFDocument.create();

            for (let i = 1; i <= totalPages; i++) {
                if (deletedPages.has(i)) continue;

                const [copiedPage] = await finalPdf.copyPages(originalPdf, [i - 1]);
                const { width, height } = copiedPage.getSize();

                if (rotationStates[i] !== undefined && rotationStates[i] !== 0) {
                    copiedPage.setRotation(PDFLib.degrees(rotationStates[i]));
                }

                if (pageObjectsCache[i]) {
                    const tempCanvasEl = document.createElement('canvas');
                    tempCanvasEl.width = width * 2;
                    tempCanvasEl.height = height * 2;

                    const tempFCanvas = new fabric.StaticCanvas(tempCanvasEl);

                    await new Promise((resolve) => {
                        tempFCanvas.loadFromJSON(pageObjectsCache[i], () => {
                            // FIX: buang border putus-putus khusus editor (whiteout
                            // tool) sebelum di-render ke PNG final, supaya yang
                            // ter-export cuma bidang putih solidnya saja, bukan
                            // garis dashed di sekelilingnya.
                            tempFCanvas.getObjects().forEach(obj => {
                                if (obj.excludeStrokeFromExport) {
                                    obj.set({ stroke: null, strokeDashArray: null });
                                }
                            });
                            tempFCanvas.setZoom(2.0);
                            tempFCanvas.renderAll();
                            resolve();
                        });
                    });

                    const highResDataUrl = tempFCanvas.toDataURL({
                        format: 'png',
                        multiplier: 1.0
                    });

                    const pngBytes = dataURLToUint8Array(highResDataUrl);
                    const pngImg = await finalPdf.embedPng(pngBytes);

                    copiedPage.drawImage(pngImg, {
                        x: 0,
                        y: 0,
                        width: width,
                        height: height,
                        opacity: 1.0
                    });

                    tempFCanvas.dispose();
                }

                finalPdf.addPage(copiedPage);
            }

            return await finalPdf.save();
        }

        // PROSES EKSPOR FINAL (DENGAN TRANSPOSISI LAYER VECTOR)
        document.getElementById('btn-export').addEventListener('click', async () => {
            if (!pdfDataBytes) return;

            saveCurrentPageObjects();
            showToast("Mengekspor file PDF final...", "info");

            try {
                const finalBytes = await buildFinalPdfBytes();
                const saved = await saveOrDownloadFile(finalBytes, `PDF_Editor_Pro_${Date.now()}.pdf`);
                if (saved) showToast("File berhasil disimpan!", "success");

            } catch (err) {
                console.error(err);
                // FIX: tampilkan pesan error asli (bukan cuma teks generik) supaya
                // kalau masih gagal, penyebabnya langsung kelihatan tanpa harus
                // buka console developer.
                const detail = err && err.message ? err.message : String(err);
                showToast(`Gagal menyimpan PDF: ${detail}`, "error");
            }
        });

        // ================== FITUR: KOMPRES PDF KE TARGET UKURAN ==================
        // Strategi: dokumen final (hasil buildFinalPdfBytes, sudah termasuk semua
        // editan) dirender ulang halaman-per-halaman jadi gambar JPEG, lalu
        // disusun jadi PDF baru dari gambar-gambar terkompresi tsb. Dicoba
        // berurutan dari preset paling ringan (kualitas terbaik) ke paling
        // agresif, berhenti begitu ukurannya sudah di bawah target -- supaya
        // kualitas yang dipakai adalah yang PALING BAGUS yang masih memenuhi
        // target, bukan langsung yang paling jelek.
        const COMPRESSION_PRESETS = [
            { scale: 1.5, quality: 0.75 },
            { scale: 1.3, quality: 0.6 },
            { scale: 1.1, quality: 0.5 },
            { scale: 1.0, quality: 0.4 },
            { scale: 0.9, quality: 0.35 },
            { scale: 0.75, quality: 0.3 },
            { scale: 0.6, quality: 0.25 },
            { scale: 0.5, quality: 0.2 }
        ];

        function formatBytes(bytes) {
            if (bytes < 1024) return `${bytes} B`;
            if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
            return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
        }

        // Render setiap halaman dari `sourceBytes` jadi JPEG pada skala &
        // kualitas tertentu, lalu susun jadi PDF baru. Ukuran halaman OUTPUT
        // tetap disamakan dengan ukuran asli (viewport scale=1) supaya dimensi
        // cetak/tampil tidak berubah -- hanya resolusi gambar & kualitas JPEG
        // yang diturunkan untuk memperkecil ukuran berkas.
        async function rasterizeAndBuildCompressedPdf(sourceBytes, renderScale, jpegQuality) {
            const loadingTask = pdfjsLib.getDocument({ data: sourceBytes.slice() });
            const srcDoc = await loadingTask.promise;
            const numPages = srcDoc.numPages;

            const outDoc = await PDFLib.PDFDocument.create();

            for (let i = 1; i <= numPages; i++) {
                const page = await srcDoc.getPage(i);
                const viewport1x = page.getViewport({ scale: 1 });
                const renderViewport = page.getViewport({ scale: renderScale });

                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(renderViewport.width));
                canvas.height = Math.max(1, Math.round(renderViewport.height));
                const ctx = canvas.getContext('2d');

                // JPEG tidak mendukung transparansi -- isi latar putih dulu supaya
                // area transparan (kalau ada) tidak berubah jadi hitam saat di-
                // convert ke JPEG.
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);

                await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;

                const jpegDataUrl = canvas.toDataURL('image/jpeg', jpegQuality);
                const jpegBytes = dataURLToUint8Array(jpegDataUrl);
                const jpegImage = await outDoc.embedJpg(jpegBytes);

                const outPage = outDoc.addPage([viewport1x.width, viewport1x.height]);
                outPage.drawImage(jpegImage, {
                    x: 0,
                    y: 0,
                    width: viewport1x.width,
                    height: viewport1x.height
                });
            }

            return await outDoc.save();
        }

        async function compressPdfToTarget(targetBytes, targetLabel) {
            if (!pdfDataBytes) return;

            saveCurrentPageObjects();
            document.getElementById('compress-modal').classList.add('hidden');
            showToast(`Menyiapkan dokumen untuk dikompres...`, "info");

            try {
                const baseBytes = await buildFinalPdfBytes();

                // Kalau dokumen (dengan semua editan) sudah di bawah target,
                // tidak perlu dikompres sama sekali -- langsung pakai versi ini
                // supaya kualitasnya tetap maksimal (utuh, bukan gambar).
                if (baseBytes.byteLength <= targetBytes) {
                    const saved = await saveOrDownloadFile(baseBytes, `PDF_Compressed_${targetLabel.replace(' ', '')}_${Date.now()}.pdf`);
                    if (saved) showToast(`Ukuran dokumen sudah di bawah ${targetLabel}, tidak perlu dikompres!`, "success");
                    return;
                }

                let bestResult = null;
                for (let idx = 0; idx < COMPRESSION_PRESETS.length; idx++) {
                    const preset = COMPRESSION_PRESETS[idx];
                    showToast(`Mengompres... mencoba level ${idx + 1}/${COMPRESSION_PRESETS.length}`, "info");

                    const compressedBytes = await rasterizeAndBuildCompressedPdf(baseBytes, preset.scale, preset.quality);
                    bestResult = compressedBytes;

                    if (compressedBytes.byteLength <= targetBytes) {
                        const saved = await saveOrDownloadFile(compressedBytes, `PDF_Compressed_${targetLabel.replace(' ', '')}_${Date.now()}.pdf`);
                        if (saved) showToast(`Berhasil dikompres jadi ${formatBytes(compressedBytes.byteLength)} (target ${targetLabel})!`, "success");
                        return;
                    }
                }

                // Tidak ada preset yang berhasil mencapai target walau sudah
                // paling agresif -- tetap unduhkan hasil terkecil yang berhasil
                // dibuat sebagai upaya terbaik, dan beri tahu user secara jujur.
                const saved = await saveOrDownloadFile(bestResult, `PDF_Compressed_Terbaik_${Date.now()}.pdf`);
                if (saved) showToast(`Tidak berhasil mencapai ${targetLabel} tanpa kualitas terlalu rusak. File terkecil yang berhasil dibuat: ${formatBytes(bestResult.byteLength)}`, "error");
            } catch (err) {
                console.error(err);
                const detail = err && err.message ? err.message : String(err);
                showToast(`Gagal mengompres PDF: ${detail}`, "error");
            }
        }

        document.getElementById('btn-compress-modal').addEventListener('click', () => {
            if (!pdfDataBytes) {
                showToast("Buka berkas PDF terlebih dahulu.", "error");
                return;
            }
            document.getElementById('compress-modal').classList.remove('hidden');
            document.getElementById('compress-current-size').innerText =
                `Ukuran dokumen saat ini: ${formatBytes(pdfDataBytes.byteLength)}`;
        });

        document.getElementById('btn-close-compress').addEventListener('click', () => {
            document.getElementById('compress-modal').classList.add('hidden');
        });

        document.querySelectorAll('.btn-compress-option').forEach(btn => {
            btn.addEventListener('click', () => {
                const targetBytes = parseInt(btn.dataset.targetBytes, 10);
                const targetLabel = btn.dataset.targetLabel;
                compressPdfToTarget(targetBytes, targetLabel);
            });
        });

        // Helper Download Berkas (fallback lama: langsung ke folder Downloads,
        // nama file otomatis). mimeType bisa disesuaikan supaya fungsi ini juga
        // dipakai ulang untuk menyimpan gambar (image/jpeg, image/png) & ZIP
        // (application/zip), bukan cuma PDF.
        function triggerDownload(bytes, filename, mimeType = 'application/pdf') {
            const blob = new Blob([bytes], { type: mimeType });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }

        // FITUR: Simpan dengan dialog "Save As" (pilih folder & nama sendiri).
        // Memakai File System Access API bawaan browser (window.showSaveFilePicker)
        // -- ini API NATIVE, bukan library tambahan, jadi tidak menambah beban
        // pemrosesan apa pun ke aplikasi, hanya memunculkan dialog OS untuk
        // memilih lokasi & nama berkas. Baru didukung browser berbasis Chromium
        // (Chrome/Edge/Brave versi desktop) dan wajib berjalan di HTTPS/localhost.
        // Untuk browser yang tidak mendukung (Firefox, Safari, kebanyakan
        // browser mobile), otomatis fallback ke cara lama (auto-download).
        // Parameter mimeType/typeDescription/extensions dibuat generik supaya
        // fungsi ini juga dipakai untuk menyimpan gambar & ZIP, bukan cuma PDF.
        async function saveOrDownloadFile(bytes, suggestedName, mimeType = 'application/pdf', typeDescription = 'PDF Document', extensions = ['.pdf']) {
            if (window.showSaveFilePicker) {
                try {
                    const handle = await window.showSaveFilePicker({
                        suggestedName: suggestedName,
                        types: [{
                            description: typeDescription,
                            accept: { [mimeType]: extensions }
                        }]
                    });
                    const writable = await handle.createWritable();
                    await writable.write(bytes);
                    await writable.close();
                    return true;
                } catch (err) {
                    // User membatalkan dialog Save As -> ini BUKAN error, jangan
                    // ditampilkan sebagai kegagalan, cukup hentikan proses diam-diam.
                    if (err.name === 'AbortError') return false;
                    console.error(err);
                    showToast("Dialog simpan gagal dibuka, mengunduh cara biasa...", "info");
                    // lanjut ke fallback di bawah
                }
            }

            // Fallback: browser tidak mendukung File System Access API
            triggerDownload(bytes, suggestedName, mimeType);
            return true;
        }

        // Membungkus beberapa gambar hasil kompresi jadi satu file ZIP (dipakai
        // fitur Kompres Gambar kalau user memilih lebih dari satu gambar
        // sekaligus, supaya tidak muncul banyak dialog Save As berurutan).
        async function saveImagesAsZip(images, zipName) {
            const zip = new JSZip();
            images.forEach(img => zip.file(img.filename, img.bytes));
            const zipBytes = await zip.generateAsync({ type: 'uint8array' });
            return await saveOrDownloadFile(zipBytes, zipName, 'application/zip', 'ZIP Archive', ['.zip']);
        }

        // Helper konversi warna HEX ke RGBA
        function hexToRgbA(hex, alpha) {
            let c;
            if (/^#([A-Fa-f0-9]{3}){1,2}$/.test(hex)) {
                c = hex.substring(1).split('');
                if (c.length == 3) {
                    c = [c[0], c[0], c[1], c[1], c[2], c[2]];
                }
                c = '0x' + c.join('');
                return 'rgba(' + [(c >> 16) & 255, (c >> 8) & 255, c & 255].join(',') + ',' + alpha + ')';
            }
            return hex;
        }