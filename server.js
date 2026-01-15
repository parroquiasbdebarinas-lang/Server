require('dotenv').config(); // Cargar variables de entorno
const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const { Pool } = require('pg'); // CAMBIO: Usamos pg en lugar de mongoose

// Configuración de CORS para permitir que Vercel se conecte a este servidor
const io = new Server(server, {
    cors: {
        origin: "*", // Permitir conexión desde cualquier URL
        methods: ["GET", "POST"]
    }
});

// --- CONEXIÓN A POSTGRESQL (Render Internal) ---
// Usamos la variable de entorno o la URL interna que me pasaste por defecto
const connectionString = process.env.DATABASE_URL || 'postgresql://admin:EKGyO0iMTE2b4aWfHypj237Ms6Gk5FbC@dpg-d5k382mr433s73ehm0b0-a/radiodb_2bfj';

const pool = new Pool({
    connectionString: connectionString,
    ssl: { rejectUnauthorized: false } // Requerido por Render
});

// --- INICIALIZACIÓN DE TABLAS (Equivalente a tus SCHEMAS de Mongoose) ---
// Creamos las tablas si no existen, respetando la estructura que tenías
const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                "user" TEXT, 
                text TEXT,
                ip TEXT,
                "isSystem" BOOLEAN,
                timestamp BIGINT
            );
            CREATE TABLE IF NOT EXISTS banned_users (
                ip TEXT PRIMARY KEY,
                reason TEXT,
                timestamp BIGINT
            );
            CREATE TABLE IF NOT EXISTS temp_bans (
                ip TEXT PRIMARY KEY,
                reason TEXT,
                expiration BIGINT
            );
            CREATE TABLE IF NOT EXISTS reports (
                id TEXT PRIMARY KEY,
                "reportedMsg" JSONB,
                reason TEXT,
                "reporterIp" TEXT,
                timestamp BIGINT
            );
        `);
        console.log('✅ Conectado a PostgreSQL y tablas verificadas');
    } catch (err) {
        console.error('❌ Error inicializando PostgreSQL:', err);
    }
};
initDB();

// --- FILTRO DE PALABRAS (INTACTO - NO TOCADO) ---
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

let connectedUsers = 0; // Contador de usuarios conectados

// Ruta por defecto para verificar que el backend está funcionando
app.get('/', (req, res) => {
    res.send('Backend de Radio Santa Bárbara: ACTIVO');
});

// Función auxiliar para desconectar inmediatamente a un usuario por IP (INTACTA)
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
io.on('connection', async (socket) => {
    // Obtener IP del cliente (compatible con Render/Vercel y Localhost)
    const clientIp = socket.handshake.headers['x-forwarded-for'] ? socket.handshake.headers['x-forwarded-for'].split(',')[0] : socket.handshake.address;

    // 1. Verificar Baneo Permanente (Adaptado a PG)
    const bannedRes = await pool.query('SELECT * FROM banned_users WHERE ip = $1', [clientIp]);
    if (bannedRes.rows.length > 0) {
        socket.emit('banned', 'Has sido baneado permanentemente.'); 
        socket.disconnect(); // Desconectar
        return;
    }

    // 2. Verificar Baneo Temporal (Adaptado a PG)
    const tempBanRes = await pool.query('SELECT * FROM temp_bans WHERE ip = $1', [clientIp]);
    if (tempBanRes.rows.length > 0) {
        const tempBan = tempBanRes.rows[0];
        // Nota: Postgres devuelve los BIGINT como strings, hay que convertir
        const expiration = parseInt(tempBan.expiration);
        
        if (Date.now() < expiration) {
            const remainingMinutes = Math.ceil((expiration - Date.now()) / 60000);
            socket.emit('banned', `Suspendido temporalmente. Tiempo restante: ${remainingMinutes} minutos.`);
            socket.disconnect();
            return;
        } else {
            await pool.query('DELETE FROM temp_bans WHERE ip = $1', [clientIp]); // El tiempo ya pasó, borrar baneo
        }
    }

    console.log('Usuario conectado desde:', clientIp);
    connectedUsers++;
    io.emit('user count', connectedUsers); // Avisar a todos cuántos hay

    // 1. Enviar SOLO los últimos 50 mensajes al entrar
    // Obtenemos los últimos 50 mensajes ordenados por fecha DESC, luego invertimos
    const recentRes = await pool.query('SELECT * FROM messages ORDER BY timestamp DESC LIMIT 50');
    // Mapeamos para mantener la estructura de objetos JS que tenías
    const sortedMessages = recentRes.rows.reverse().map(row => ({
        id: row.id,
        user: row.user,
        text: row.text,
        ip: row.ip,
        isSystem: row.isSystem,
        timestamp: parseInt(row.timestamp)
    }));

    // Importante: No enviar la IP a los usuarios normales por seguridad
    const sanitizedRecent = sortedMessages.map(m => ({ ...m, ip: undefined }));
    
    socket.emit('recent history', {
        messages: sanitizedRecent,
        hasMore: true // Siempre asumimos que puede haber más en DB
    });

    // 2. Escuchar petición de "Cargar mensajes antiguos"
    socket.on('request full history', async () => {
        const allRes = await pool.query('SELECT * FROM messages ORDER BY timestamp ASC');
        const allMessages = allRes.rows.map(row => ({
            id: row.id, user: row.user, text: row.text, ip: row.ip, isSystem: row.isSystem, timestamp: parseInt(row.timestamp)
        }));
        socket.emit('full history', allMessages);
    });

    // 3. Enviar reportes al admin cuando se conecta (o lo pide)
    socket.on('admin request reports', async () => {
        const reportsRes = await pool.query('SELECT * FROM reports ORDER BY timestamp DESC');
        const reports = reportsRes.rows.map(row => ({
            id: row.id, reportedMsg: row.reportedMsg, reason: row.reason, reporterIp: row.reporterIp, timestamp: parseInt(row.timestamp)
        }));
        socket.emit('all reports', reports);
    });

    // Cuando alguien envía un mensaje
    socket.on('chat message', async (msg) => {
        // --- SEGURIDAD: VERIFICAR BANEO ANTES DE PROCESAR ---
        const isBannedNow = await pool.query('SELECT * FROM banned_users WHERE ip = $1', [clientIp]);
        if (isBannedNow.rows.length > 0) {
            socket.emit('banned', 'Has sido baneado permanentemente.');
            socket.disconnect();
            return;
        }
        
        const tempBanNow = await pool.query('SELECT * FROM temp_bans WHERE ip = $1', [clientIp]);
        if (tempBanNow.rows.length > 0) {
             const expiration = parseInt(tempBanNow.rows[0].expiration);
             if (Date.now() < expiration) {
                socket.disconnect();
                return;
             }
        }

        // 3. FILTRADO DE PALABRAS (Tu lógica original)
        let cleanText = msg.text;
        
        // Usar el filtro avanzado (Regex generado arriba)
        badWordsRegex.forEach(regex => {
            cleanText = cleanText.replace(regex, '****');
        });
        
        // Actualizar el texto del mensaje con la versión limpia
        msg.text = cleanText;
        
        // Asignar un ID único al mensaje
        msg.id = Date.now().toString() + Math.random().toString(36).substr(2, 9);
        msg.timestamp = Date.now(); // Guardar la hora exacta
        msg.ip = clientIp; // Guardar la IP
        const isSystem = msg.isSystem || false;

        // 4. Guardar el mensaje en el historial (INSERT SQL)
        await pool.query(
            'INSERT INTO messages (id, "user", text, ip, "isSystem", timestamp) VALUES ($1, $2, $3, $4, $5, $6)',
            [msg.id, msg.user, msg.text, msg.ip, isSystem, msg.timestamp]
        );

        // Reenviarlo a TODOS los conectados
        // Enviamos una copia SIN la IP para proteger la privacidad
        io.emit('chat message', { ...msg, ip: undefined });
    });

    // --- EVENTOS DE ADMINISTRADOR ---
    
    // Borrar todo el chat
    socket.on('admin clear chat', async () => {
        await pool.query('DELETE FROM messages'); // Borrar todos
        io.emit('chat cleared'); // Avisar a todos
    });

    // Borrar mensaje individual
    socket.on('admin delete message', async (id) => {
        await pool.query('DELETE FROM messages WHERE id = $1', [id]);
        io.emit('message deleted', id); // Avisar a todos
    });

    // Banear usuario por ID de mensaje
    socket.on('admin ban user', async (data) => {
        // Soporta recibir solo ID (string) o objeto { msgId, reason }
        const msgId = typeof data === 'object' ? data.msgId : data;
        const reason = typeof data === 'object' ? data.reason : 'Comportamiento inadecuado';

        const msgRes = await pool.query('SELECT * FROM messages WHERE id = $1', [msgId]);
        if (msgRes.rows.length > 0) {
            const msg = msgRes.rows[0];
            const ipToBan = msg.ip;

            const alreadyBanned = await pool.query('SELECT * FROM banned_users WHERE ip = $1', [ipToBan]);
            if (alreadyBanned.rows.length === 0) {
                
                await pool.query('INSERT INTO banned_users (ip, reason, timestamp) VALUES ($1, $2, $3)', [ipToBan, reason, Date.now()]);
                console.log(`IP Baneada: ${ipToBan} (Usuario: ${msg.user})`);
                
                // Desconectar inmediatamente
                disconnectUserByIp(ipToBan, 'Has sido baneado permanentemente. Razón: ' + reason);

                // Avisar en el chat
                const sysMsgData = { id: Date.now().toString(), user: 'SISTEMA', text: `El usuario ${msg.user} ha sido bloqueado. Razón: ${reason}`, isSystem: true, timestamp: Date.now() };
                
                await pool.query(
                    'INSERT INTO messages (id, "user", text, ip, "isSystem", timestamp) VALUES ($1, $2, $3, $4, $5, $6)',
                    [sysMsgData.id, sysMsgData.user, sysMsgData.text, null, true, sysMsgData.timestamp]
                );
                
                io.emit('chat message', sysMsgData);
            }
        }
    });

    // Baneo Temporal (Actualizado para soportar Segundos/Minutos/Horas)
    socket.on('admin temp ban', async (data) => {
        // data espera: { msgId, time, unit, reason }
        const msgRes = await pool.query('SELECT * FROM messages WHERE id = $1', [data.msgId]);
        
        if (msgRes.rows.length > 0) {
            const msg = msgRes.rows[0];
            let duration = 0;
            const timeVal = parseInt(data.time);
            
            if (data.unit === 'seconds') duration = timeVal * 1000;
            else if (data.unit === 'hours') duration = timeVal * 60 * 60 * 1000;
            else duration = timeVal * 60 * 1000; // Default: minutos

            const expiration = Date.now() + duration;

            // Upsert (Insertar o Actualizar si existe)
            await pool.query(`
                INSERT INTO temp_bans (ip, reason, expiration) 
                VALUES ($1, $2, $3)
                ON CONFLICT (ip) 
                DO UPDATE SET expiration = $3, reason = $2
            `, [msg.ip, data.reason, expiration]);
            
            // Desconectar inmediatamente
            disconnectUserByIp(msg.ip, `Suspendido temporalmente por ${data.time} ${data.unit}. Razón: ${data.reason}`);
            
            // Avisar en el chat
            const sysMsgData = { 
                id: Date.now().toString(), 
                user: 'SISTEMA', 
                text: `El usuario ${msg.user} ha sido suspendido temporalmente (${data.time} ${data.unit}). Razón: ${data.reason}`, 
                isSystem: true, 
                timestamp: Date.now() 
            };
            
            await pool.query(
                'INSERT INTO messages (id, "user", text, "isSystem", timestamp) VALUES ($1, $2, $3, $4, $5)',
                [sysMsgData.id, sysMsgData.user, sysMsgData.text, true, sysMsgData.timestamp]
            );

            io.emit('chat message', sysMsgData);
        }
    });

    // Reportar Mensaje (Nuevo)
    socket.on('report message', async (data) => {
        // data = { id, reason }
        const msgRes = await pool.query('SELECT * FROM messages WHERE id = $1', [data.id]);
        if (msgRes.rows.length > 0) {
            const msg = msgRes.rows[0];
            // Reconstruimos el objeto mensaje para guardarlo en el JSON
            const msgObj = {
                id: msg.id, user: msg.user, text: msg.text, ip: msg.ip, isSystem: msg.isSystem, timestamp: parseInt(msg.timestamp)
            };

            const report = {
                id: Date.now().toString(),
                reportedMsg: msgObj,
                reason: data.reason,
                timestamp: Date.now(),
                reporterIp: clientIp
            };
            
            await pool.query(
                'INSERT INTO reports (id, "reportedMsg", reason, "reporterIp", timestamp) VALUES ($1, $2, $3, $4, $5)',
                [report.id, report.reportedMsg, report.reason, report.reporterIp, report.timestamp]
            );

            io.emit('new report', report); // Enviar alerta a los admins conectados
        }
    });

    // Enviar mensaje de Sistema
    socket.on('admin system message', async (text) => {
        const msg = {
            id: Date.now().toString(),
            user: 'SISTEMA',
            text: text,
            isSystem: true, // Marca especial para estilos
            timestamp: Date.now()
        };
        
        await pool.query(
            'INSERT INTO messages (id, "user", text, "isSystem", timestamp) VALUES ($1, $2, $3, $4, $5)',
            [msg.id, msg.user, msg.text, true, msg.timestamp]
        );
        
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