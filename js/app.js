// Initialize PDF.js
// When opened via file://, some browsers block workers; fall back to no-worker mode
if (typeof pdfjsLib !== 'undefined') {
  if (location.protocol === 'file:') {
    // Disable worker for local file usage to avoid CORS/worker loading errors
    pdfjsLib.GlobalWorkerOptions.workerSrc = null;
    pdfjsLib.disableWorker = true;
  } else {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

// Heuristic: identify Table of Contents/summary-like pages
function isLikelyTOC(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    const keywords = [
        'table of contents', 'contents', 'summary', 'index',
        'sumário', 'sumario', 'índice', 'indice', 'conteúdo', 'conteudo'
    ];
    if (keywords.some(k => lower.includes(k))) return true;
    // Dot leaders and page-number heavy lines are typical in TOC
    const dotLeader = /\.{4,}/.test(text);
    const manyNumbers = (text.match(/\b\d{1,3}\b/g) || []).length >= 8;
    return dotLeader || manyNumbers;
}

// Detect the start index of the first chapter heading within text, or -1 if not found
function findChapterStartIndex(text, pageNumber = 1) {
    if (!text) return -1;
    // Ignore potential matches on early pages or TOC-like pages
    const minPage = getMinChapterPage();
    if (pageNumber < minPage) return -1;
    if (isLikelyTOC(text)) return -1;

    const patterns = [
        /\bchapter\s+(\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i,
        /\bcap[ií]tulo\s+(\d+|[ivxlcdm]+|um|dois|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez)\b/i
    ];
    for (const re of patterns) {
        const m = text.match(re);
        if (m && m.index !== undefined) return m.index;
    }
    return -1;
}
}

// Build a book object from a PDF File
async function buildBookFromFile(file) {
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;

    // Extract cover from first page
    let coverDataUrl = '';
    try {
        const firstPage = await pdf.getPage(1);
        const v = firstPage.getViewport({ scale: 0.5 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(v.width);
        canvas.height = Math.floor(v.height);
        await firstPage.render({ canvasContext: canvas.getContext('2d'), viewport: v }).promise;
        coverDataUrl = canvas.toDataURL('image/jpeg', 0.8);
    } catch (e) {
        console.warn('Failed to extract cover:', e);
    }

    // Extract chunks per page
    const chunks = [];
    const numPages = pdf.numPages;
    let foundChapterStart = !shouldSkipFrontMatter();
    for (let p = 1; p <= numPages; p++) {
        try {
            const page = await pdf.getPage(p);
            let textItems = '';
            try {
                const textContent = await page.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
                textItems = textContent.items.map(it => it.str).join(' ').trim();
            } catch {}

            if (!foundChapterStart) {
                // Try to locate the first chapter heading in this page
                const cutIndex = findChapterStartIndex(textItems, p);
                if (cutIndex >= 0) {
                    foundChapterStart = true;
                    textItems = textItems.slice(cutIndex); // include from chapter heading onward
                } else {
                    // Still in front matter, skip this page entirely
                    continue;
                }
            }

            if (textItems && textItems.length > 0) {
                const pageChunks = splitIntoSentenceChunks(textItems, 4);
                for (const ct of pageChunks) {
                    chunks.push({ type: 'text', content: ct });
                }
            } else {
                // canvas chunk
                if (foundChapterStart) {
                    const scale = 1.25;
                    const v = page.getViewport({ scale });
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.floor(v.width);
                    canvas.height = Math.floor(v.height);
                    await page.render({ canvasContext: canvas.getContext('2d'), viewport: v }).promise;
                    const imgUrl = canvas.toDataURL('image/jpeg', 0.85);
                    chunks.push({ type: 'image', content: imgUrl });
                } // else still front matter image, skip
            }
        } catch (err) {
            console.warn('Page parse failed:', err);
        }
    }

    return {
        name: file.name.replace(/\.pdf$/i, ''),
        cover: coverDataUrl,
        chunks
    };
}

// Append additional PDFs and re-interleave
async function processAdditionalFiles(files) {
    try {
        const capacity = Math.max(0, 4 - booksState.length);
        const intake = Array.from(files).slice(0, capacity);
        for (const file of intake) {
            const book = await buildBookFromFile(file);
            booksState.push(book);
        }
        interleaveBooksIntoScreens(booksState);
        documentTitle.textContent = booksState.map(b => b.name).join(' • ');
    } catch (e) {
        console.error('Error adding PDFs:', e);
        alert('Error adding PDFs. Please try again.');
    }
}

// New: Process multiple files (up to 4), build chunks per book, then interleave
async function processMultipleFiles(files) {
    try {
        console.log('[processMultipleFiles] starting with files:', files.map(f => f.name));
        if (typeof pdfjsLib === 'undefined') {
            throw new Error('PDF.js (pdfjsLib) is not loaded');
        }
        uploadScreen.classList.add('active');
        readerScreen.classList.remove('active');
        dropZone.innerHTML = '<div class="loading">Processing PDFs...</div>';

        // Prepare structures per book
        const books = [];
        for (const file of files) {
            console.log('[processMultipleFiles] building book for', file.name);
            const book = await buildBookFromFile(file);
            console.log('[processMultipleFiles] built book', book && book.name, 'chunks:', book && book.chunks && book.chunks.length);
            books.push(book);
        }

        // Interleave chunks round-robin across books
        booksState = books.slice(0, 4);
        interleaveBooksIntoScreens(booksState);

        // Switch to reader view
        uploadScreen.classList.remove('active');
        readerScreen.classList.add('active');

        // Update recent docs (store first only for now)
        if (books[0]) {
            currentDocument = {
                name: books.map(b => b.name).join(' + '),
                lastOpened: new Date().toISOString(),
                pages: [], currentPage: 1, progress: 0
            };
            saveToRecentDocuments(currentDocument);
        }
    } catch (error) {
        console.error('Error processing PDFs:', error && (error.stack || error.message || error));
        const msg = (error && (error.message || error.toString())) || 'Unknown error';
        alert('Error processing PDFs: ' + msg + '\nAttempting single-file mode with the first PDF...');
        try {
            if (files && files.length > 0) {
                await processFile(files[0]);
                return;
            }
        } catch (singleErr) {
            console.error('Single-file fallback failed:', singleErr && (singleErr.stack || singleErr.message || singleErr));
        }
        location.reload();
    }
}

function interleaveBooksIntoScreens(books) {
    // Reset content
    readerContent.innerHTML = '';
    pages = [];
    totalPages = 0;
    currentPageNum = 1;
    totalPagesEl.textContent = '0';
    documentTitle.textContent = books.map(b => b.name).join(' • ');

    // Round-robin until all chunks exhausted
    const positions = books.map(() => 0);
    let remaining = books.reduce((sum, b) => sum + b.chunks.length, 0);
    while (remaining > 0) {
        for (let i = 0; i < books.length; i++) {
            const pos = positions[i];
            const book = books[i];
            if (pos >= book.chunks.length) continue;
            const chunk = book.chunks[pos];
            positions[i]++;
            remaining--;

            // Create screen
            const screen = document.createElement('div');
            screen.className = 'page book-bg';
            if (book.cover) {
                screen.style.backgroundImage = `url(${book.cover})`;
            }

            const content = document.createElement('div');
            content.className = 'page-content framed';

            if (chunk.type === 'text') {
                content.textContent = chunk.content;
            } else if (chunk.type === 'image') {
                const img = document.createElement('img');
                img.src = chunk.content;
                img.alt = 'Page';
                img.style.width = '100%';
                img.style.height = 'auto';
                content.appendChild(img);
            }

            screen.appendChild(content);
            totalPages += 1;
            screen.dataset.pageNumber = String(totalPages);
            readerContent.appendChild(screen);
            pages[totalPages] = { element: screen, rendered: true };
        }
    }

    totalPagesEl.textContent = String(totalPages);
    pageIndicator.textContent = `Page ${currentPageNum} of ${totalPages}`;

    // Scroll to first
    setTimeout(() => {
        const first = document.querySelector('.page[data-page-number="1"]');
        if (first) {
            first.scrollIntoView({ behavior: 'auto', block: 'start' });
            updateProgress(1);
            updateNavigation();
        }
    }, 100);
}

// DOM Elements
const uploadScreen = document.getElementById('upload-screen');
const readerScreen = document.getElementById('reader-screen');
const fileInput = document.getElementById('file-input');
const browseBtn = document.getElementById('browse-btn');
const dropZone = document.getElementById('drop-zone');
const readerContent = document.getElementById('reader-content');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const documentTitle = document.getElementById('document-title');
const pageIndicator = document.getElementById('page-indicator');
const currentPageEl = document.getElementById('current-page');
const totalPagesEl = document.getElementById('total-pages');
const prevPageBtn = document.getElementById('prev-page');
const nextPageBtn = document.getElementById('next-page');
const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.querySelector('.settings-panel');
const settingsMenu = document.getElementById('settings-menu');
const fontSizeInput = document.getElementById('font-size');
const lineHeightInput = document.getElementById('line-height');
const themeSelect = document.getElementById('theme');
const skipFrontMatterCheckbox = document.getElementById('skip-front-matter');
const minChapterPageInput = document.getElementById('min-chapter-page');
const minChapterPageDisplay = document.getElementById('min-chapter-page-display');
const recentDocsContainer = document.getElementById('recent-docs');
const addFilesBtn = document.getElementById('add-files-btn');

// State
let currentPdf = null;
// We treat each text chunk (4 sentences) as a "page" (screen)
let currentPageNum = 1; // current screen number
let totalPages = 0;     // total screens (chunks), grows as we render
let pages = [];         // pages[screenNumber] = { element, rendered }
// Keep a global list of books for interleaving so we can append more later
let booksState = [];
let isScrolling = false;
let scrollTimeout = null;
let currentDocument = {
    name: '',
    lastOpened: null,
    pages: [],
    currentPage: 1,
    progress: 0
};

// Constants
const RECENT_DOCS_KEY = 'recentDocuments';
const MAX_RECENT_DOCS = 5;

// Initialize the app
function init() {
    console.log('Initializing app...');
    
    // Check if required elements exist
    if (!browseBtn) console.error('Browse button not found');
    if (!fileInput) console.error('File input not found');
    if (!dropZone) console.error('Drop zone not found');
    
    setupEventListeners();
    loadSettings();
    loadRecentDocuments();
    
    console.log('App initialized');
}

// Set up event listeners
function setupEventListeners() {
    // File input handling
    // Handle browse button click
    if (browseBtn && fileInput) {
        browseBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            // Create a new input element to ensure the change event fires every time
            const newInput = document.createElement('input');
            newInput.type = 'file';
            newInput.accept = '.pdf';
            newInput.style.display = 'none';
            
            newInput.addEventListener('change', (e) => {
                console.log('File input changed (dynamic)');
                if (newInput.files && newInput.files.length > 0) {
                    console.log('File selected (dynamic):', newInput.files[0].name);
                    // Transfer the file to the main file input
                    const dataTransfer = new DataTransfer();
                    dataTransfer.items.add(newInput.files[0]);
                    fileInput.files = dataTransfer.files;
                    
                    // Trigger the file processing
                    handleFileSelect(e).catch(error => {
                        console.error('Error handling file selection:', error);
                        alert('Error processing the file. Please try again.');
                    });
                }
                // Clean up
                document.body.removeChild(newInput);
            });
            
            // Add to body and trigger click
            document.body.appendChild(newInput);
            newInput.click();
        });
    }
    
    // Handle direct file input change (if user clicks the hidden input directly)
    if (fileInput) {
        fileInput.addEventListener('change', (e) => {
            console.log('File input changed (direct)');
            if (fileInput.files && fileInput.files.length > 0) {
                console.log('File selected (direct):', fileInput.files[0].name);
                handleFileSelect(e).catch(error => {
                    console.error('Error handling file selection:', error);
                    alert('Error processing the file. Please try again.');
                });
            }
        });
    }
    
    // Drag and drop handling
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
    });
    
    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, highlight, false);
    });
    
    // Allow clicking anywhere in the drop zone to open file picker
    if (dropZone && fileInput) {
        dropZone.addEventListener('click', (e) => {
            // Ignore clicks on actual controls that already handle file input
            const target = e.target;
            const isControl = target.id === 'browse-btn' || target.id === 'file-input' || target.closest('#browse-btn');
            if (isControl) return;
            fileInput.click();
        });
    }

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, unhighlight, false);
    });
    
    dropZone.addEventListener('drop', handleDrop, false);
    
    // Navigation
    prevPageBtn.addEventListener('click', goToPreviousPage);
    nextPageBtn.addEventListener('click', goToNextPage);
    
    // Settings
    settingsBtn.addEventListener('click', toggleSettings);
    fontSizeInput.addEventListener('input', updateFontSize);
    lineHeightInput.addEventListener('input', updateLineHeight);
    themeSelect.addEventListener('change', updateTheme);
    if (minChapterPageInput && minChapterPageDisplay) {
        minChapterPageInput.addEventListener('input', () => {
            minChapterPageDisplay.textContent = String(minChapterPageInput.value);
        });
        minChapterPageInput.addEventListener('change', saveSettings);
    }
    
    // Handle scroll events for infinite scrolling
    readerContent.addEventListener('scroll', handleScroll);
    
    // Handle keyboard navigation
    document.addEventListener('keydown', handleKeyDown);

    // Add more PDFs from reader screen
    if (addFilesBtn) {
        addFilesBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const newInput = document.createElement('input');
            newInput.type = 'file';
            newInput.accept = '.pdf';
            newInput.multiple = true;
            newInput.style.display = 'none';
            newInput.addEventListener('change', async () => {
                const capacity = Math.max(0, 4 - booksState.length);
                const files = Array.from(newInput.files || []).slice(0, capacity);
                if (files.length > 0) {
                    await processAdditionalFiles(files);
                }
                document.body.removeChild(newInput);
            });
            document.body.appendChild(newInput);
            newInput.click();
        });
    }
}

// Prevent default drag and drop behavior
function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

// Highlight drop zone when dragging over it
function highlight() {
    dropZone.style.borderColor = '#2563eb';
    dropZone.style.backgroundColor = 'rgba(37, 99, 235, 0.05)';
}

// Remove highlight from drop zone
function unhighlight() {
    dropZone.style.borderColor = '';
    dropZone.style.backgroundColor = '';
}

// Handle file selection via file input
async function handleFileSelect(e) {
    const files = Array.from(e.target.files || []).slice(0, 4);
    if (files.length) {
        await processMultipleFiles(files);
    }
}

// Handle file drop
async function handleDrop(e) {
    const dt = e.dataTransfer;
    const files = Array.from(dt.files || []).filter(f => f.type === 'application/pdf').slice(0, 4);
    if (files.length) {
        await processMultipleFiles(files);
    }
}

// Process the uploaded PDF file
async function processFile(file) {
    try {
        // Show loading state
        dropZone.innerHTML = '<div class="loading">Processing PDF...</div>';
        
        // Read the file as ArrayBuffer
        const arrayBuffer = await file.arrayBuffer();
        
        // Load the PDF document
        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        currentPdf = await loadingTask.promise;
        // We'll compute total screens dynamically while rendering
        totalPages = 0;
        
        // Update UI
        documentTitle.textContent = file.name.replace(/\.pdf$/i, '');
        totalPagesEl.textContent = '0';
        
        // Store document info
        currentDocument = {
            name: file.name,
            lastOpened: new Date().toISOString(),
            pages: [],
            currentPage: 1,
            progress: 0,
            fileSize: file.size,
            lastModified: file.lastModified
        };
        
        // Render the first few pages
        await renderPages();
        
        // Switch to reader view
        uploadScreen.classList.remove('active');
        readerScreen.classList.add('active');
        
        // Save to recent documents
        saveToRecentDocuments(currentDocument);
        
    } catch (error) {
        console.error('Error processing PDF:', error);
        alert('Error processing PDF. Please try another file.');
        location.reload();
    }
}

// Render all pages of the PDF into sentence-based chunks
async function renderPages() {
    if (!currentPdf) return;
    
    // Clear existing content
    readerContent.innerHTML = '';
    pages = [];
    totalPages = 0;
    currentPageNum = 1;
    totalPagesEl.textContent = '0';
    
    const numPages = currentPdf.numPages;
    let foundChapterStart = !shouldSkipFrontMatter();
    for (let i = 1; i <= numPages; i++) {
        await renderPage(i, { foundChapterStartRef: () => foundChapterStart, setFound: () => { foundChapterStart = true; } });
    }
    
    // Scroll to first screen
    setTimeout(() => {
        const pageElement = document.querySelector(`.page[data-page-number="1"]`);
        if (pageElement) {
            pageElement.scrollIntoView({ behavior: 'auto', block: 'start' });
            updateProgress(1);
            updateNavigation();
        }
    }, 100);
}

// Render a single page
async function renderPage(pageNumber, opts = {}) {
    try {
        const page = await currentPdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1.5 });
        
        // Create page container
        const pageDiv = document.createElement('div');
        pageDiv.className = 'page';
        pageDiv.dataset.pageNumber = pageNumber;
        
        // Extract text content with normalization
        let textItems = '';
        try {
            const textContent = await page.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
            textItems = textContent.items.map(item => item.str).join(' ').trim();
        } catch (err) {
            console.warn(`Text extraction failed for page ${pageNumber}:`, err);
        }

        // Handle front matter skipping (single-file flow)
        let foundChapterStart = opts.foundChapterStartRef ? opts.foundChapterStartRef() : true;
        if (!foundChapterStart) {
            const cutIndex = findChapterStartIndex(textItems, pageNumber);
            if (cutIndex >= 0) {
                if (opts.setFound) opts.setFound();
                foundChapterStart = true;
                textItems = textItems.slice(cutIndex);
            } else {
                // Skip entire page
                return null;
            }
        }

        if (textItems && textItems.length > 0) {
            // Split into 4-sentence chunks
            const chunks = splitIntoSentenceChunks(textItems, 4);
            for (const chunkText of chunks) {
                const chunkDiv = document.createElement('div');
                chunkDiv.className = 'page';
                const contentDiv = document.createElement('div');
                contentDiv.className = 'page-content';
                contentDiv.textContent = chunkText;
                chunkDiv.appendChild(contentDiv);
                totalPages += 1;
                chunkDiv.dataset.pageNumber = String(totalPages);
                readerContent.appendChild(chunkDiv);
                pages[totalPages] = { element: chunkDiv, rendered: true };
            }
        } else {
            // Fallback: render the whole PDF page to a canvas as a single chunk
            if (foundChapterStart) {
                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d');
                const scale = 1.25;
                const fallbackViewport = page.getViewport({ scale });
                canvas.width = Math.floor(fallbackViewport.width);
                canvas.height = Math.floor(fallbackViewport.height);
                const renderContext = { canvasContext: context, viewport: fallbackViewport };
                await page.render(renderContext).promise;
                const canvasContainer = document.createElement('div');
                canvasContainer.className = 'page';
                canvasContainer.appendChild(canvas);
                totalPages += 1;
                canvasContainer.dataset.pageNumber = String(totalPages);
                readerContent.appendChild(canvasContainer);
                pages[totalPages] = { element: canvasContainer, rendered: true };
            } else {
                return null;
            }
        }
        
        // Update totals in UI
        totalPagesEl.textContent = String(totalPages);
        pageIndicator.textContent = `Page ${currentPageNum} of ${totalPages}`;
        
        return null;
    } catch (error) {
        console.error(`Error rendering page ${pageNumber}:`, error);
        return null;
    }
}

// Split text into chunks of N sentences, keeping punctuation
function splitIntoSentenceChunks(text, sentencesPerChunk = 4) {
    // Split by sentence terminators while keeping them attached
    const sentences = text
        .split(/(?<=\.)\s+/)
        .map(s => s.trim())
        .filter(s => s.length > 0);
    const chunks = [];
    for (let i = 0; i < sentences.length; i += sentencesPerChunk) {
        const group = sentences.slice(i, i + sentencesPerChunk);
        chunks.push(group.join(' '));
    }
    return chunks;
}

// Update progress bar and text
function updateProgress(currentPage) {
    if (!totalPages) return;
    
    const progress = Math.round((currentPage / totalPages) * 100);
    progressBar.style.width = `${progress}%`;
    progressText.textContent = `${progress}%`;
    
    // Update current page indicator
    currentPageEl.textContent = currentPage;
    pageIndicator.textContent = `Page ${currentPage} of ${totalPages}`;
    
    // Update document progress
    if (currentDocument) {
        currentDocument.currentPage = currentPage;
        currentDocument.progress = progress;
        currentDocument.lastOpened = new Date().toISOString();
        saveToRecentDocuments(currentDocument);
    }
}

// Handle scroll events for infinite scrolling
function handleScroll() {
    if (isScrolling) return;
    
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
        const scrollPosition = readerContent.scrollTop + (readerContent.clientHeight / 2);
        const pageElements = document.querySelectorAll('.page');
        
        // Find the current page based on scroll position
        for (let i = 0; i < pageElements.length; i++) {
            const element = pageElements[i];
            const rect = element.getBoundingClientRect();
            const elementMiddle = rect.top + (rect.height / 2) - readerContent.getBoundingClientRect().top;
            
            if (elementMiddle >= 0 && elementMiddle <= readerContent.clientHeight) {
                const pageNumber = parseInt(element.dataset.pageNumber);
                if (pageNumber !== currentPageNum) {
                    currentPageNum = pageNumber;
                    updateProgress(currentPageNum);
                    updateNavigation();
                    loadAdjacentPages();
                }
                break;
            }
        }
    }, 100);
}

// Load adjacent pages as needed
function loadAdjacentPages() {
    if (!currentPdf) return;
    
    const startPage = Math.max(1, currentPageNum - 1);
    const endPage = Math.min(totalPages, currentPageNum + 3);
    
    for (let i = startPage; i <= endPage; i++) {
        if (!pages[i] || !pages[i].rendered) {
            renderPage(i);
        }
    }
}

// Update navigation buttons state
function updateNavigation() {
    prevPageBtn.disabled = currentPageNum <= 1;
    nextPageBtn.disabled = currentPageNum >= totalPages;
}

// Go to previous page
function goToPreviousPage() {
    if (currentPageNum > 1) {
        currentPageNum--;
        scrollToPage(currentPageNum);
    }
}

// Go to next page
function goToNextPage() {
    if (currentPageNum < totalPages) {
        currentPageNum++;
        scrollToPage(currentPageNum);
    }
}

// Scroll to specific page
function scrollToPage(pageNumber) {
    const pageElement = document.querySelector(`.page[data-page-number="${pageNumber}"]`);
    if (pageElement) {
        isScrolling = true;
        pageElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
        updateProgress(pageNumber);
        updateNavigation();
        
        // Reset scrolling flag after animation
        setTimeout(() => {
            isScrolling = false;
        }, 500);
    }
}

// Handle keyboard navigation
function handleKeyDown(e) {
    if (!readerScreen.classList.contains('active')) return;
    
    switch (e.key) {
        case 'ArrowUp':
        case 'ArrowLeft':
        case 'PageUp':
        case 'k':
            e.preventDefault();
            goToPreviousPage();
            break;
            
        case 'ArrowDown':
        case 'ArrowRight':
        case 'PageDown':
        case 'j':
        case ' ':
            e.preventDefault();
            goToNextPage();
            break;
            
        case 'Home':
            e.preventDefault();
            currentPageNum = 1;
            scrollToPage(currentPageNum);
            break;
            
        case 'End':
            e.preventDefault();
            currentPageNum = totalPages;
            scrollToPage(currentPageNum);
            break;
    }
}

// Toggle settings panel
function toggleSettings() {
    settingsPanel.classList.toggle('active');
}

// Update font size
function updateFontSize() {
    const size = `${fontSizeInput.value}px`;
    document.documentElement.style.setProperty('--font-size', size);
    document.querySelectorAll('.page-content').forEach(el => {
        el.style.fontSize = size;
    });
    saveSettings();
}

// Update line height
function updateLineHeight() {
    const height = lineHeightInput.value;
    document.documentElement.style.setProperty('--line-height', height);
    document.querySelectorAll('.page-content').forEach(el => {
        el.style.lineHeight = height;
    });
    saveSettings();
}

// Update theme
function updateTheme() {
    const theme = themeSelect.value;
    document.documentElement.setAttribute('data-theme', theme);
    saveSettings();
}

// Save settings to localStorage
function saveSettings() {
    const settings = {
        fontSize: fontSizeInput.value,
        lineHeight: lineHeightInput.value,
        theme: themeSelect.value,
        skipFrontMatter: !!(skipFrontMatterCheckbox && skipFrontMatterCheckbox.checked),
        minChapterPage: minChapterPageInput ? parseInt(minChapterPageInput.value, 10) : 5
    };
    localStorage.setItem('pdfReaderSettings', JSON.stringify(settings));
}

// Load settings from localStorage
function loadSettings() {
    const savedSettings = localStorage.getItem('pdfReaderSettings');
    if (savedSettings) {
        const settings = JSON.parse(savedSettings);
        
        if (settings.fontSize) {
            fontSizeInput.value = settings.fontSize;
            document.documentElement.style.setProperty('--font-size', `${settings.fontSize}px`);
        }
        
        if (settings.lineHeight) {
            lineHeightInput.value = settings.lineHeight;
            document.documentElement.style.setProperty('--line-height', settings.lineHeight);
        }
        
        if (settings.theme) {
            themeSelect.value = settings.theme;
            document.documentElement.setAttribute('data-theme', settings.theme);
        }
        if (typeof settings.skipFrontMatter === 'boolean' && skipFrontMatterCheckbox) {
            skipFrontMatterCheckbox.checked = settings.skipFrontMatter;
        }
        if (typeof settings.minChapterPage === 'number' && minChapterPageInput && minChapterPageDisplay) {
            minChapterPageInput.value = String(settings.minChapterPage);
            minChapterPageDisplay.textContent = String(settings.minChapterPage);
        } else if (minChapterPageInput && minChapterPageDisplay) {
            // initialize display
            minChapterPageDisplay.textContent = String(minChapterPageInput.value);
        }
    }
}

function shouldSkipFrontMatter() {
    return !!(skipFrontMatterCheckbox && skipFrontMatterCheckbox.checked);
}

function getMinChapterPage() {
    if (minChapterPageInput) {
        const n = parseInt(minChapterPageInput.value, 10);
        return Number.isFinite(n) ? n : 5;
    }
    return 5;
}

// Save document to recent documents
function saveToRecentDocuments(doc) {
    if (!doc || !doc.name) return;
    
    let recentDocs = JSON.parse(localStorage.getItem(RECENT_DOCS_KEY) || '[]');
    
    // Check if document already exists in recent
    const existingDocIndex = recentDocs.findIndex(d => 
        d.name === doc.name && d.fileSize === doc.fileSize && d.lastModified === doc.lastModified
    );
    
    // Update existing or add new
    if (existingDocIndex >= 0) {
        recentDocs[existingDocIndex] = { ...recentDocs[existingDocIndex], ...doc };
    } else {
        recentDocs.unshift(doc);
    }
    
    // Limit to max recent documents
    recentDocs = recentDocs.slice(0, MAX_RECENT_DOCS);
    
    // Save to localStorage
    localStorage.setItem(RECENT_DOCS_KEY, JSON.stringify(recentDocs));
    
    // Update UI
    loadRecentDocuments();
}

// Load and display recent documents
function loadRecentDocuments() {
    const recentDocs = JSON.parse(localStorage.getItem(RECENT_DOCS_KEY) || '[]');
    
    if (recentDocs.length === 0) {
        recentDocsContainer.style.display = 'none';
        return;
    }
    
    recentDocsContainer.style.display = 'block';
    recentDocsContainer.innerHTML = '<h3>Recent Documents</h3>';
    
    recentDocs.forEach(doc => {
        const docElement = document.createElement('div');
        docElement.className = 'recent-doc';
        docElement.innerHTML = `
            <svg class="recent-doc-icon" viewBox="0 0 24 24" width="24" height="24">
                <path fill="currentColor" d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>
            </svg>
            <div class="recent-doc-info">
                <div class="recent-doc-name">${doc.name}</div>
                <div class="recent-doc-date">${formatDate(doc.lastOpened)} • ${formatFileSize(doc.fileSize)}</div>
            </div>
        `;
        
        docElement.addEventListener('click', () => {
            // For demo purposes, we'll just show the document name
            // In a real app, you would load the document from storage
            alert(`Loading document: ${doc.name}\n\nIn a real implementation, this would load the document from storage.`);
        });
        
        recentDocsContainer.appendChild(docElement);
    });
}

// Format date for display
function formatDate(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    return date.toLocaleDateString(undefined, { 
        year: 'numeric', 
        month: 'short', 
        day: 'numeric' 
    });
}

// Format file size for display
function formatFileSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Initialize the app when the DOM is loaded
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// Expose key functions globally (some environments/cache can cause scope issues)
window.buildBookFromFile = buildBookFromFile;
window.processMultipleFiles = processMultipleFiles;
window.processAdditionalFiles = processAdditionalFiles;
