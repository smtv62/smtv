const fs = require('fs');
const axios = require('axios');

const LOCAL_FILE = 'turkce.m3u';
const REMOTE_URL = 'https://link.testworkery0.workers.dev/patron.m3u';
const MATCH_THRESHOLD = 0.8; // %80 ve üzeri benzerlikleri aynı kanal sayar

// Türkçe karakterleri İngilizce karşılıklarına çevirir ve temizler
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
        .replace(/[\s\-\+\(\)hd|]/g, '') // Boşlukları, HD ibaresini ve özel karakterleri siler
        .trim();
}

// İki metin arasındaki benzerlik oranını hesaplar (Levenshtein Distance)
function getSimilarity(s1, s2) {
    const n1 = normalizeText(s1);
    const n2 = normalizeText(s2);
    
    if (n1 === n2) return 1.0;
    if (n1.includes(n2) || n2.includes(n1)) return 0.9; // Biri diğerinin içinde geçiyorsa yüksek puan

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
    try {
        // Sadece header kontrolü yaparak (HEAD isteği) hızı artırıyoruz
        const response = await axios.head(url, { timeout: 4000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        return response.status === 200;
    } catch (error) {
        // Bazı sunucular HEAD isteğine 405 verebilir, garanti olsun diye GET ile tekrar deneriz
        try {
            const response = await axios.get(url, { timeout: 4000, headers: { 'User-Agent': 'Mozilla/5.0' } });
            return response.status === 200;
        } catch (e) {
            return false;
        }
    }
}

// En benzer kanalı bulan fonksiyon
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

    // Tarih TV ve Sinema TV 1002 aralığını filtrele
    let startIndex = remoteChannels.findIndex(c => normalizeText(c.name).includes("tarihtv"));
    let endIndex = remoteChannels.findIndex(c => normalizeText(c.name).includes("sinematv1002"));

    if (startIndex === -1) startIndex = 0;
    if (endIndex === -1) endIndex = remoteChannels.length - 1;

    const filteredRemoteChannels = remoteChannels.slice(startIndex, endIndex + 1);
    console.log(`🎯 Hedef aralıktan ${filteredRemoteChannels.length} kanal filtrelendi.`);

    // 1. Yerel kanalları kontrol et ve güncelle
    for (let localChan of localChannels) {
        console.log(`🔎 Kontrol ediliyor: ${localChan.name}`);
        const isWorking = await checkChannel(localChan.url);

        if (!isWorking) {
            console.log(`⚠️ Çalışmıyor: ${localChan.name}. Güncel link aranıyor...`);
            const matchInRemote = findBestMatch(localChan.name, filteredRemoteChannels);
            
            if (matchInRemote) {
                localChan.url = matchInRemote.url;
                console.log(`✅ ${localChan.name} -> ${matchInRemote.name} olarak eşleşti ve linki güncellendi.`);
            } else {
                console.log(`❌ ${localChan.name} için uzak listede benzer bir karşılık bulunamadı.`);
            }
        }
    }

    // 2. Yerelde olmayan (hiç eşleşmeyen) yeni kanalları ekle
    for (let remoteChan of filteredRemoteChannels) {
        const hasMatch = localChannels.some(l => getSimilarity(l.name, remoteChan.name) >= MATCH_THRESHOLD);
        if (!hasMatch) {
            localChannels.push(remoteChan);
            console.log(`➕ Yeni kanal listeye dahil edildi: ${remoteChan.name}`);
        }
    }

    // 3. Dosyayı kaydet
    let newM3U = "#EXTM3U\n";
    localChannels.forEach(c => {
        newM3U += `${c.info}\n${c.url}\n`;
    });

    fs.writeFileSync(LOCAL_FILE, newM3U, 'utf-8');
    console.log("💾 turkce.m3u başarıyla güncellendi ve kaydedildi!");
}

start().catch(err => console.error("🚨 Kritik Hata:", err));
