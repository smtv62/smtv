const fs = require('fs');
const axios = require('axios');

const LOCAL_FILE = 'turkce.m3u';
const REMOTE_URL = 'https://raw.githubusercontent.com/Adnan4161/TvCanli41/refs/heads/main/%40Kargo1975_Saraydorf_de_rectv_%20txt.m3u';
const ULUSAL_URL = 'https://raw.githubusercontent.com/smtv62/ulusal/refs/heads/main/ulusal.m3u';

const MATCH_THRESHOLD = 0.75; // Eşleşme hassasiyeti (%75)
const CONCURRENCY_LIMIT = 10; // Aynı anda 10 kanalı birden kontrol eder

// Güncellenmiş hedef kanal listesi
const TARGET_CHANNELS = [
    "BBC Earth", "DocuScreen", "Viasathistory", "Viasat Explore", 
    "Discovery Channel", "Discovery ID", "Love Nature", "National Geographic", 
    "Natgeo Wild", "B Gurme", "B IZ", "Sinema Aile", "Sinema Aksiyon", 
    "Sinema Aksiyon 2", "Sinema Yerli", "Sinema Komedi", "Sinema Komedi 2", 
    "Sinema Tv", "Sinema Tv 2", "Sinema 1001", "Sinema 1002",
    "Star Tv", "Show Tv" // Ulusal listeden beslenecek kanallar listeye dahil edildi
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

// Kanalın ulusal listeden mi yoksa ana listeden mi aranacağına karar veren yardımcı fonksiyon
function isUlusalChannel(channelName) {
    const normalized = normalizeText(channelName);
    return normalized.includes("startv") || normalized.includes("showtv");
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

    console.log("🌐 Uzak listelerden veriler çekiliyor...");
    const remoteResponse = await axios.get(REMOTE_URL);
    const remoteChannels = parseM3U(remoteResponse.data);

    const ulusalResponse = await axios.get(ULUSAL_URL);
    const ulusalChannels = parseM3U(ulusalResponse.data);

    // İki uzak listeyi hedef kanallara göre filtreleyip birleştiriyoruz
    const filteredRemoteChannels = remoteChannels.filter(remoteChan => {
        if (isUlusalChannel(remoteChan.name)) return false; // Star/Show buraya düşmesin
        return TARGET_CHANNELS.some(targetName => getSimilarity(remoteChan.name, targetName) >= MATCH_THRESHOLD);
    });

    const filteredUlusalChannels = ulusalChannels.filter(remoteChan => {
        if (!isUlusalChannel(remoteChan.name)) return false; // Sadece Star/Show buraya düşsün
        return TARGET_CHANNELS.some(targetName => getSimilarity(remoteChan.name, targetName) >= MATCH_THRESHOLD);
    });

    // Filtrelenmiş listeleri tek çatı altında birleştiriyoruz
    const allFilteredRemoteChannels = [...filteredRemoteChannels, ...filteredUlusalChannels];
    
    console.log(`🎯 Hedef listeden ${allFilteredRemoteChannels.length} kanal başarıyla filtrelendi.`);

    // Sadece TARGET_CHANNELS listesinde yer alan yerel kanalları güncelleme işlemine tabi tutuyoruz
    const localChannelsToProcess = localChannels.filter(localChan => 
        TARGET_CHANNELS.some(targetName => getSimilarity(localChan.name, targetName) >= MATCH_THRESHOLD)
    );

    console.log(`🔎 Belirlenen ${localChannelsToProcess.length} adet kanal için kontroller paralel olarak başlıyor...`);
    
    await processInChunks(localChannelsToProcess, CONCURRENCY_LIMIT, async (localChan) => {
        console.log(`⏱️ Kontrol ediliyor: ${localChan.name}`);
        const isWorking = await checkChannel(localChan.url);

        if (!isWorking) {
            console.log(`⚠️ Çalışmıyor: ${localChan.name}. Güncel link aranıyor...`);
            
            // Star ve Show TV için ulusal kaynak havuzunu, diğerleri için ana havuzu kullan
            const searchSource = isUlusalChannel(localChan.name) ? filteredUlusalChannels : filteredRemoteChannels;
            const matchInRemote = findBestMatch(localChan.name, searchSource);
            
            if (matchInRemote) {
                // Orijinal localChannels dizisindeki referansı bulup güncelliyoruz
                const originalChan = localChannels.find(l => l.info === localChan.info && l.url === localChan.url);
                if (originalChan) {
                    originalChan.url = matchInRemote.url;
                    console.log(`✅ ${localChan.name} -> ${matchInRemote.name} olarak eşleşti ve güncellendi.`);
                }
            } else {
                console.log(`❌ ${localChan.name} için uzak listede benzer bir karşılık bulunamadı.`);
            }
        } else {
            console.log(`🟢 Aktif: ${localChan.name}`);
        }
    });

    // 2. Yerelde olmayan yeni kanalları ekle (Sırayla ve yalnızca filtrelenmiş hedef listedekileri ekler)
    for (let targetName of TARGET_CHANNELS) {
        // Yerel listede bu kanal zaten var mı?
        const hasMatchInLocal = localChannels.some(l => getSimilarity(l.name, targetName) >= MATCH_THRESHOLD);
        
        if (!hasMatchInLocal) {
            // Hangi havuzdan arayacağımızı seçiyoruz
            const searchSource = isUlusalChannel(targetName) ? filteredUlusalChannels : filteredRemoteChannels;
            const matchInRemote = findBestMatch(targetName, searchSource);
            
            if (matchInRemote) {
                localChannels.push(matchInRemote);
                console.log(`➕ Yeni hedef kanal eklendi: ${matchInRemote.name}`);
            }
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
