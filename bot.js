const fs = require('fs');
const axios = require('axios');

const LOCAL_FILE = 'turkce.m3u';
const REMOTE_URL = 'https://raw.githubusercontent.com/Adnan4161/TvCanli41/refs/heads/main/%40Kargo1975_Saraydorf_de_rectv_%20txt.m3u';
const MATCH_THRESHOLD = 0.75; // Eşleşme hassasiyeti (%75)
const CONCURRENCY_LIMIT = 10; // Aynı anda 10 kanalı birden kontrol eder

// Adsız.png görselindeki tam hedef kanal listesi
const TARGET_CHANNELS = [
    "Tarih TV", "National Geographic", "National Geographic Wild", 
    "Viasat Nature", "Viasat History", "Love Nature", "BBC Earth", 
    "Discovery Channel", "Discovery Science", "Discovery ID", 
    "Viasat Explore", "DocuBOX", "Yaban Tv", "TGRT Belgesel", "Çiftçi Tv",
    "Fx", "Fx Yedek", 
    "Sinema Tv", "Sinema Tv Yedek", "Sinema Tv Yedek 2", 
    "Sinema Tv 2", "Sinema Tv 2 Yedek", 
    "Sinema Aile", "Sinema Tv Aile Yedek", "Sinema Aile Yedek 2", "Sinema Aile 2", 
    "Sinema Aksiyon", "Sinema Tv Aksiyon Yedek", "Sinema Aksiyon Yedek 2", "Sinema Aksiyon 2", 
    "Sinema Komedi", "Sinema Tv Komedi Yedek", "Sinema Komedi Yedek 2", "Sinema Komedi 2", 
    "Sinema Tv 1001", "Sinema Tv 1001 Yedek", "Sinema 1001 Yedek 2", "Sinema Tv 1002"
];

function normalizeText(text) {
    if (!text) return "";
    return text
        .toLowerCase()
        .replace(/ı/g, 'i')
        .replace(/ğ/g, 'g')
        .replace(/ü/g, 'u')
        .replace(/ş/g, 's')
        .replace(/ö/g, 'o')
        .replace(/ç/g, 'c')
        .replace(/^[a-z0-9]{2,3}\s*[|:]/g, '') // Ülke ön eklerini temizler
        .replace(/[\s\-\+\(\)hd|4k]/g, '') // Boşluk, HD, 4K ibarelerini siler
        .trim();
}

function getSimilarity(s1, s2) {
    const n1 = normalizeText(s1);
    const n2 = normalizeText(s2);
    
    if (n1 === n2) return 1.0;
    if (n1.includes(n2) || n2.includes(n1)) return 0.85;

    let longer = n1;
    let shorter = n2;
    if (n1.length < n2.length) {
        longer = n2;
        shorter = n1;
    }
    let longerLength = longer.length;
    if (longerLength === 0) return 1.0;

    return (longerLength - editDistance(longer, shorter)) / parseFloat(longerLength);
}

function editDistance(s1, s2) {
    let costs = [];
    for (let i = 0; i <= s1.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= s2.length; j++) {
            if (i == 0) costs[j] = j;
            else {
                if (j > 0) {
                    let newValue = costs[j - 1];
                    if (s1.charAt(i - 1) != s2.charAt(j - 1))
                        newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                    costs[j - 1] = lastValue;
                    lastValue = newValue;
                }
            }
        }
        if (i > 0) costs[s2.length] = lastValue;
    }
    return costs[s2.length];
}

function parseM3U(content) {
    const lines = content.split('\n');
    const channels = [];
    let currentInfo = null;

    for (let line of lines) {
        line = line.trim();
        if (line.startsWith('#EXTINF:')) {
            currentInfo = line;
        } else if (line && !line.startsWith('#')) {
            if (currentInfo) {
                const nameMatch = currentInfo.match(/,(.+)$/);
                const name = nameMatch ? nameMatch[1].trim() : "Bilinmeyen Kanal";
                channels.push({ info: currentInfo, url: line, name: name });
                currentInfo = null;
            }
        }
    }
    return channels;
}

async function checkChannel(url) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    try {
        const response = await axios.head(url, { 
            signal: controller.signal, 
            headers: { 'User-Agent': 'Mozilla/5.0' } 
        });
        clearTimeout(timeoutId);
        return response.status === 200;
    } catch (error) {
        clearTimeout(timeoutId);
        const getController = new AbortController();
        const getTimeoutId = setTimeout(() => getController.abort(), 3000);
        try {
            const response = await axios.get(url, { 
                signal: getController.signal, 
                headers: { 'User-Agent': 'Mozilla/5.0' } 
            });
            clearTimeout(getTimeoutId);
            return response.status === 200;
        } catch (e) {
            clearTimeout(getTimeoutId);
            return false;
        }
    }
}

function findBestMatch(localName, remoteChannels) {
    let bestMatch = null;
    let highestScore = 0;

    for (const remoteChan of remoteChannels) {
        const score = getSimilarity(localName, remoteChan.name);
        if (score > highestScore) {
            highestScore = score;
            bestMatch = remoteChan;
        }
    }

    return highestScore >= MATCH_THRESHOLD ? bestMatch : null;
}

async function processInChunks(array, chunkSize, iteratorFn) {
    for (let i = 0; i < array.length; i += chunkSize) {
        const chunk = array.slice(i, i + chunkSize);
        await Promise.all(chunk.map(iteratorFn));
    }
}

async function start() {
    console.log("🔄 İşlem başlatıldı...");

    if (!fs.existsSync(LOCAL_FILE)) {
        fs.writeFileSync(LOCAL_FILE, "#EXTM3U\n");
    }
    const localContent = fs.readFileSync(LOCAL_FILE, 'utf-8');
    const localChannels = parseM3U(localContent);

    console.log("🌐 Uzak listeden veriler çekiliyor...");
    const remoteResponse = await axios.get(REMOTE_URL);
    const remoteChannels = parseM3U(remoteResponse.data);

    // Eski index aralığı yerine, uzak listeden sadece görseldeki hedef listeyle eşleşenleri filtreliyoruz
    const filteredRemoteChannels = remoteChannels.filter(remoteChan => {
        return TARGET_CHANNELS.some(targetName => getSimilarity(remoteChan.name, targetName) >= MATCH_THRESHOLD);
    });
    
    console.log(`🎯 Hedef listeden ${filteredRemoteChannels.length} kanal başarıyla filtrelendi.`);

    console.log("🔎 Kanal kontrolleri ve güncellemeler paralel olarak başlıyor...");
    
    await processInChunks(localChannels, CONCURRENCY_LIMIT, async (localChan) => {
        console.log(`⏱️ Kontrol ediliyor: ${localChan.name}`);
        const isWorking = await checkChannel(localChan.url);

        if (!isWorking) {
            console.log(`⚠️ Çalışmıyor: ${localChan.name}. Güncel link aranıyor...`);
            const matchInRemote = findBestMatch(localChan.name, filteredRemoteChannels);
            
            if (matchInRemote) {
                localChan.url = matchInRemote.url;
                console.log(`✅ ${localChan.name} -> ${matchInRemote.name} olarak eşleşti ve güncellendi.`);
            } else {
                console.log(`❌ ${localChan.name} için uzak listede benzer bir karşılık bulunamadı.`);
            }
        } else {
            console.log(`🟢 Aktif: ${localChan.name}`);
        }
    });

    // 2. Yerelde olmayan yeni kanalları ekle (Yalnızca filtrelenmiş hedef listedekileri ekler)
    for (let remoteChan of filteredRemoteChannels) {
        const hasMatch = localChannels.some(l => getSimilarity(l.name, remoteChan.name) >= MATCH_THRESHOLD);
        if (!hasMatch) {
            localChannels.push(remoteChan);
            console.log(`➕ Yeni hedef kanal eklendi: ${remoteChan.name}`);
        }
    }

    // 3. Dosyayı kaydet
    let newM3U = "#EXTM3U\n";
    localChannels.forEach(c => {
        newM3U += `${c.info}\n${c.url}\n`;
    });

    fs.writeFileSync(LOCAL_FILE, newM3U, 'utf-8');
    console.log(`💾 ${LOCAL_FILE} başarıyla güncellendi ve kaydedildi!`);
}

start().catch(err => console.error("🚨 Kritik Hata:", err));
