import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import express from 'express';
import fetch from 'node-fetch';
import https from 'https';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Set up static file serving
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
app.use(express.static(join(__dirname, 'public')));

// Configure fetch agent with proper SSL handling
const agent = new https.Agent({
    rejectUnauthorized: true,
    checkServerIdentity: (host, cert) => {
        // You can implement custom certificate validation here if needed
        return undefined; // Accept the certificate
    }
});

// Configure express to parse JSON
app.use(express.json());

// Reset endpoint to destroy the current session and clean up auth files
app.post('/reset', async (req, res) => {
    try {
        // Destroy the client session and disconnect from WhatsApp
        if (client) {
            await client.destroy();
            console.log('WhatsApp client destroyed');
        }

        // Notify all connected WebSocket clients about the reset
        wss.clients.forEach((wsClient) => {
            wsClient.send(JSON.stringify({ 
                type: 'status', 
                message: 'Resetting WhatsApp session...'
            }));
        });

        // Create a new client instance with fresh authentication
        const newClient = new Client({
            authStrategy: new LocalAuth(),
            puppeteer: {
                headless: true,
                args: ['--no-sandbox']
            }
        });

        // Set up event handlers for the new client
        newClient.on('qr', (qr) => {
            console.log('New QR Code received');
            wss.clients.forEach((wsClient) => {
                wsClient.send(JSON.stringify({ type: 'qr', qr }));
            });
        });

        newClient.on('ready', () => {
            console.log('New client is ready!');
            wss.clients.forEach((wsClient) => {
                wsClient.send(JSON.stringify({ type: 'ready' }));
            });
        });

        // Initialize the new client
        await newClient.initialize();
        
        // Update the global client reference
        client = newClient;

        res.json({ 
            success: true, 
            message: 'WhatsApp session reset successfully. Please scan the new QR code.'
        });

    } catch (error) {
        console.error('Error resetting session:', error);
        // Notify WebSocket clients about the error
        wss.clients.forEach((wsClient) => {
            wsClient.send(JSON.stringify({ 
                type: 'error', 
                message: 'Failed to reset WhatsApp session. Please try again.'
            }));
        });
        res.status(500).json({ 
            success: false, 
            message: 'Failed to reset WhatsApp session',
            error: error.message 
        });
    }
});

// Initialize WhatsApp client
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox']
    }
});

// Handle WebSocket connections
wss.on('connection', (ws) => {
    console.log('New WebSocket connection');
    
    // Send QR code to connected clients
    client.on('qr', (qr) => {
        console.log('QR Code received');
        ws.send(JSON.stringify({ type: 'qr', qr }));
    });

    // Send ready status to connected clients
    client.on('ready', () => {
        ws.send(JSON.stringify({ type: 'ready' }));
    });
});

// Handle client ready event
client.on('ready', () => {
    console.log('Client is ready!');
});

// Handle incoming messages
client.on('message', async msg => {
    const chat = await msg.getChat();
    console.log(`New message from ${chat.name}: ${msg.body}`);

    // Forward message to n8n webhook (you'll need to set this up in n8n)
    const maxRetries = 3;
    let retryCount = 0;
    
    while (retryCount < maxRetries) {
        try {
            const response = await fetch('https://n8n.kav.co.id/webhook-test/whatsapp', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({
                    message: msg.body,
                    from: msg.from,
                    timestamp: msg.timestamp
                }),
                agent: agent,
                timeout: 10000 // 10 seconds timeout to handle slower connections
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
            }
            
            // Handle n8n response
            const data = await response.json();
            if (data.reply) {
                await msg.reply(data.reply);
            }
            break; // Success, exit the retry loop
        } catch (error) {
            retryCount++;
            console.error(`Attempt ${retryCount}/${maxRetries} - Error forwarding message to n8n:`, error);
            
            if (retryCount === maxRetries) {
                let errorMessage = 'Sorry, I am having trouble processing your message right now.';
                if (error.code === 'EPROTO' || error.code === 'ECONNREFUSED') {
                    errorMessage = 'Unable to establish a secure connection with the server. Please check the SSL configuration.';
                } else if (error.type === 'system') {
                    errorMessage = 'A system error occurred. Please try again later.';
                }
                await msg.reply(errorMessage);
                break;
            }
            
            // Wait before retrying (exponential backoff)
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, retryCount)));
        }
    }
});

// API endpoint for sending messages (can be triggered from n8n)
app.post('/send-message', async (req, res) => {
    try {
        const { to, message } = req.body;
        await client.sendMessage(to, message);
        res.json({ success: true });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Initialize WhatsApp client and start server
client.initialize();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}. Open http://localhost:${PORT} to scan QR code.`);
});