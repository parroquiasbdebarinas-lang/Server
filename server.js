const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const fs = require('fs'); // Necesario para guardar archivos

// Configuración de CORS para permitir que Vercel se conecte a este servidor
const io = new Server(server, {
    cors: {
        origin: "*", // Permitir conexión desde cualquier URL (por seguridad, luego puedes poner solo tu dominio de Vercel)
        methods: ["GET", "POST"]
    }
});
const path = require('path');
const DATA_FILE = path.join(__dirname, 'chat_history.json'); // Archivo donde se guardarán los mensajes
const BANNED_FILE = path.join(__dirname, 'banned_ips.json'); // Archivo de IPs baneadas
const TEMP_BANS_FILE = path.join(__dirname, 'temp_bans.json'); // Archivo de Baneos Temporales

// --- FILTRO DE PALABRAS (Extenso - Latam/España/USA) ---
const badWords = [
    "puta", "puto", "mierda", "verga", "pendejo", "estupido", "idiota", "imbecil",
    "cabron", "marico", "marica", "zorra", "mamaguevo", "coño", "joder", "carajo",
    "fuck", "shit", "bitch", "asshole", "dick", "pussy", "cunt", "bastard",
    "malparido", "gonorrea", "pirobo", "carechimba", "boludo", "pelotudo",
    "conchatumadre", "hijueputa", "gilipollas", "capullo", "mamahuevo",
    "pinga", "culo", "teton", "tetas", "vagina", "pene", "sexo", "porno",
    "xxx", "nopor", "maldito", "maldita", "basura", "kk",
    "qlo", "culero", "pinche", "wey", "weon", "aweonao", "chucha", "vergazos"
];

// Generar Regex avanzado para cada mala palabra (Detecta: p.u.t.a, puuuta, p4t4, m1erda)
const badWordsRegex = badWords.map(word => {
    const charMap = {
        'a': '[aá@4]', 'e': '[eé3]', 'i': '[ií1]', 'o': '[oó0]', 'u': '[uú]',
        's': '[s5$]', 't': '[t7]', 'b': '[b8]'
    };
    const pattern = word.split('').map(c => {
        return (charMap[c] || c) + '+'; // Permitir repeticiones (uu) y leetspeak (4, 3, 1)
    }).join('\\W*'); // Permitir cualquier caracter no alfanumérico en medio (p.u.t.a)
    return new RegExp(`\\b${pattern}\\b`, 'gi');
});

// Array para guardar el historial de mensajes (en memoria)
const chatHistory = [];
const MAX_HISTORY = 500; // Guardamos hasta 500 mensajes en memoria
let connectedUsers = 0; // Contador de usuarios conectados
const bannedIPs = []; // Lista de IPs baneadas en memoria
const tempBans = {}; // Mapa de IPs baneadas temporalmente { ip: timestamp_expiracion }
const reports = []; // Lista de reportes en memoria

// --- PERSISTENCIA: Cargar historial al iniciar ---
if (fs.existsSync(DATA_FILE)) {
    try {
        const data = fs.readFileSync(DATA_FILE, 'utf8');
        const loaded = JSON.parse(data);
        if (Array.isArray(loaded)) {
            chatHistory.push(...loaded);
            console.log(`Historial cargado: ${chatHistory.length} mensajes.`);
        }
    } catch (e) {
        console.error("Error cargando historial:", e);
    }
}
function saveHistory() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(chatHistory, null, 2));
}
// Cargar IPs baneadas
if (fs.existsSync(BANNED_FILE)) {
    try {
        const data = fs.readFileSync(BANNED_FILE, 'utf8');
        const loaded = JSON.parse(data);
        if (Array.isArray(loaded)) bannedIPs.push(...loaded);
    } catch (e) { console.error("Error cargando bans:", e); }
}
function saveBanned() {
    fs.writeFileSync(BANNED_FILE, JSON.stringify(bannedIPs, null, 2));
}
// Cargar Baneos Temporales
if (fs.existsSync(TEMP_BANS_FILE)) {
    try {
        const data = fs.readFileSync(TEMP_BANS_FILE, 'utf8');
        Object.assign(tempBans, JSON.parse(data));
    } catch (e) { console.error("Error cargando temp bans:", e); }
}
function saveTempBans() {
    fs.writeFileSync(TEMP_BANS_FILE, JSON.stringify(tempBans, null, 2));
}

// Ruta por defecto para verificar que el backend está funcionando
app.get('/', (req, res) => {
    res.send('Backend de Radio Santa Bárbara: ACTIVO');
});

// Función auxiliar para desconectar inmediatamente a un usuario por IP
function disconnectUserByIp(ip, reason) {
    const connectedSockets = io.sockets.sockets; // Map de sockets conectados
    connectedSockets.forEach((socket) => {
        const socketIp = socket.handshake.headers['x-forwarded-for'] ? socket.handshake.headers['x-forwarded-for'].split(',')[0] : socket.handshake.address;
        if (socketIp === ip) {
            socket.emit('banned', reason);
            socket.disconnect(); // Desconexión forzada inmediata
        }
    });
}

// Lógica de conexión del Chat
io.on('connection', (socket) => {
    // Obtener IP del cliente (compatible con Render/Vercel y Localhost)
    const clientIp = socket.handshake.headers['x-forwarded-for'] ? socket.handshake.headers['x-forwarded-for'].split(',')[0] : socket.handshake.address;

    // 1. Verificar Baneo Permanente
    if (bannedIPs.includes(clientIp)) {
        socket.emit('banned', 'Has sido baneado permanentemente.'); 
        socket.disconnect(); // Desconectar
        return;
    }

    // 2. Verificar Baneo Temporal
    if (tempBans[clientIp]) {
        if (Date.now() < tempBans[clientIp]) {
            const remainingMinutes = Math.ceil((tempBans[clientIp] - Date.now()) / 60000);
            socket.emit('banned', `Suspendido temporalmente. Tiempo restante: ${remainingMinutes} minutos.`);
            socket.disconnect();
            return;
        } else {
            delete tempBans[clientIp]; // El tiempo ya pasó, borrar baneo
            saveTempBans();
        }
    }

    console.log('Usuario conectado desde:', clientIp);
    connectedUsers++;
    io.emit('user count', connectedUsers); // Avisar a todos cuántos hay

    // 1. Enviar SOLO los últimos 50 mensajes al entrar
    const recentMessages = chatHistory.slice(-50);
    // Importante: No enviar la IP a los usuarios normales por seguridad
    const sanitizedRecent = recentMessages.map(m => ({ ...m, ip: undefined }));
    
    socket.emit('recent history', {
        messages: sanitizedRecent,
        hasMore: chatHistory.length > 50 // Avisar si hay más mensajes antiguos
    });

    // 2. Escuchar petición de "Cargar mensajes antiguos"
    socket.on('request full history', () => {
        socket.emit('full history', chatHistory);
    });

    // 3. Enviar reportes al admin cuando se conecta (o lo pide)
    socket.on('admin request reports', () => {
        socket.emit('all reports', reports);
    });

    // Cuando alguien envía un mensaje
    socket.on('chat message', (msg) => {
        // --- SEGURIDAD: VERIFICAR BANEO ANTES DE PROCESAR ---
        if (bannedIPs.includes(clientIp)) {
            socket.emit('banned', 'Has sido baneado permanentemente.');
            socket.disconnect();
            return;
        }
        if (tempBans[clientIp]) {
            if (Date.now() < tempBans[clientIp]) {
                const remainingMinutes = Math.ceil((tempBans[clientIp] - Date.now()) / 60000);
                socket.emit('banned', `Suspendido temporalmente. Tiempo restante: ${remainingMinutes} minutos.`);
                socket.disconnect();
                return;
            } else {
                delete tempBans[clientIp];
                saveTempBans();
            }
        }

        // 3. FILTRADO DE PALABRAS
        let cleanText = msg.text;
        
        // Usar el filtro avanzado (Regex generado arriba)
        badWordsRegex.forEach(regex => {
            cleanText = cleanText.replace(regex, '****');
        });
        
        // Actualizar el texto del mensaje con la versión limpia
        msg.text = cleanText;
        
        // Asignar un ID único al mensaje (necesario para borrarlo individualmente)
        msg.id = Date.now().toString() + Math.random().toString(36).substr(2, 9);
        msg.timestamp = Date.now(); // Guardar la hora exacta
        msg.ip = clientIp; // Guardar la IP (para poder banearlo luego)

        // 4. Guardar el mensaje en el historial
        chatHistory.push(msg);
        saveHistory(); // Guardar en archivo

        // Mantener solo los últimos 500 mensajes para no llenar la memoria de Render
        if (chatHistory.length > MAX_HISTORY) {
            chatHistory.shift();
        }

        // Reenviarlo a TODOS los conectados
        // Enviamos una copia SIN la IP para proteger la privacidad
        io.emit('chat message', { ...msg, ip: undefined });
    });

    // --- EVENTOS DE ADMINISTRADOR ---
    
    // Borrar todo el chat
    socket.on('admin clear chat', () => {
        chatHistory.length = 0; // Vaciar historial
        saveHistory(); // Guardar cambios
        io.emit('chat cleared'); // Avisar a todos
    });

    // Borrar mensaje individual
    socket.on('admin delete message', (id) => {
        const index = chatHistory.findIndex(m => m.id === id);
        if (index !== -1) {
            chatHistory.splice(index, 1); // Borrar del historial
            saveHistory(); // Guardar cambios
            io.emit('message deleted', id); // Avisar a todos para que lo quiten de su pantalla
        }
    });

    // Banear usuario por ID de mensaje
    socket.on('admin ban user', (data) => {
        // Soporta recibir solo ID (string) o objeto { msgId, reason }
        const msgId = typeof data === 'object' ? data.msgId : data;
        const reason = typeof data === 'object' ? data.reason : 'Comportamiento inadecuado';

        const msg = chatHistory.find(m => m.id === msgId);
        if (msg && msg.ip) {
            if (!bannedIPs.includes(msg.ip)) {
                bannedIPs.push(msg.ip);
                saveBanned();
                console.log(`IP Baneada: ${msg.ip} (Usuario: ${msg.user})`);
                
                // Desconectar inmediatamente
                disconnectUserByIp(msg.ip, 'Has sido baneado permanentemente. Razón: ' + reason);

                // Avisar en el chat
                const sysMsg = { id: Date.now().toString(), user: 'SISTEMA', text: `El usuario ${msg.user} ha sido bloqueado. Razón: ${reason}`, isSystem: true, timestamp: Date.now() };
                chatHistory.push(sysMsg); saveHistory(); io.emit('chat message', sysMsg);
            }
        }
    });

    // Baneo Temporal (Actualizado para soportar Segundos/Minutos/Horas)
    socket.on('admin temp ban', (data) => {
        // data espera: { msgId, time, unit, reason }
        // unit puede ser: 'seconds', 'minutes', 'hours'
        const msg = chatHistory.find(m => m.id === data.msgId);
        if (msg && msg.ip) {
            let duration = 0;
            const timeVal = parseInt(data.time);
            
            if (data.unit === 'seconds') duration = timeVal * 1000;
            else if (data.unit === 'hours') duration = timeVal * 60 * 60 * 1000;
            else duration = timeVal * 60 * 1000; // Default: minutos

            tempBans[msg.ip] = Date.now() + duration;
            saveTempBans();
            
            // Desconectar inmediatamente
            disconnectUserByIp(msg.ip, `Suspendido temporalmente por ${data.time} ${data.unit}. Razón: ${data.reason}`);
            
            // Avisar en el chat
            const sysMsg = { 
                id: Date.now().toString(), 
                user: 'SISTEMA', 
                text: `El usuario ${msg.user} ha sido suspendido temporalmente (${data.time} ${data.unit}). Razón: ${data.reason}`, 
                isSystem: true, 
                timestamp: Date.now() 
            };
            chatHistory.push(sysMsg); saveHistory(); io.emit('chat message', sysMsg);
        }
    });

    // Reportar Mensaje (Nuevo)
    socket.on('report message', (data) => {
        // data = { id, reason }
        const msg = chatHistory.find(m => m.id === data.id);
        if (msg) {
            const report = {
                id: Date.now().toString(),
                reportedMsg: msg,
                reason: data.reason,
                timestamp: Date.now(),
                reporterIp: clientIp
            };
            reports.push(report);
            io.emit('new report', report); // Enviar alerta a los admins conectados
        }
    });

    // Enviar mensaje de Sistema
    socket.on('admin system message', (text) => {
        const msg = {
            id: Date.now().toString(),
            user: 'SISTEMA',
            text: text,
            isSystem: true, // Marca especial para estilos
            timestamp: Date.now()
        };
        chatHistory.push(msg);
        saveHistory(); // Guardar cambios
        io.emit('chat message', msg);
    });

    socket.on('disconnect', () => {
        console.log('Usuario desconectado');
        connectedUsers--;
        io.emit('user count', connectedUsers); // Actualizar contador al salir
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor de Radio Santa Bárbara corriendo en http://localhost:${PORT}`);
});