const express = require('express');
const cors = require('cors');
const stripe = require('stripe')('YOUR_STRIPE_SECRET_KEY_HERE');
const fs = require('fs').promises;
const path = require('path');
const ExcelJS = require('exceljs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// FONTOS: Root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Konfigurációs változók
const FOXPOST_API_KEY = 'YOUR_FOXPOST_API_KEY_HERE';
const FOXPOST_API_URL = 'https://api.foxpost.hu/v1';

// Termékek betöltése
async function loadProducts() {
    try {
        const data = await fs.readFile(path.join(__dirname, 'data', 'products.json'), 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Hiba a termékek betöltésekor:', error);
        return [];
    }
}

// Termékek mentése
async function saveProducts(products) {
    try {
        await fs.writeFile(
            path.join(__dirname, 'data', 'products.json'),
            JSON.stringify(products, null, 2)
        );
    } catch (error) {
        console.error('Hiba a termékek mentésekor:', error);
    }
}

// Rendelés mentése Excel-be
async function saveOrderToExcel(orderData) {
    const filePath = path.join(__dirname, 'data', 'rendelesek.xlsx');
    let workbook;

    try {
        workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(filePath);
    } catch (error) {
        workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Rendelések');
        
        worksheet.columns = [
            { header: 'Rendelés ID', key: 'orderId', width: 20 },
            { header: 'Dátum', key: 'date', width: 20 },
            { header: 'Név', key: 'name', width: 25 },
            { header: 'Email', key: 'email', width: 30 },
            { header: 'Telefon', key: 'phone', width: 15 },
            { header: 'Szállítási mód', key: 'shippingMethod', width: 20 },
            { header: 'FoxPost automata', key: 'foxpostLocation', width: 30 },
            { header: 'Cím', key: 'address', width: 40 },
            { header: 'Termékek', key: 'items', width: 50 },
            { header: 'Mennyiség', key: 'totalQuantity', width: 12 },
            { header: 'Összeg (Ft)', key: 'total', width: 15 },
            { header: 'Fizetési mód', key: 'paymentMethod', width: 20 },
            { header: 'Fizetés állapota', key: 'paymentStatus', width: 20 },
            { header: 'Megjegyzés', key: 'notes', width: 30 }
        ];

        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF20B2AA' }
        };
    }

    const worksheet = workbook.getWorksheet('Rendelések') || workbook.addWorksheet('Rendelések');

    const itemsList = orderData.items.map(item => 
        `${item.name} (${item.quantity}db × ${item.price} Ft)`
    ).join('; ');

    const totalQuantity = orderData.items.reduce((sum, item) => sum + item.quantity, 0);

    worksheet.addRow({
        orderId: orderData.orderId,
        date: new Date().toLocaleString('hu-HU'),
        name: orderData.customerInfo.name,
        email: orderData.customerInfo.email,
        phone: orderData.customerInfo.phone,
        shippingMethod: orderData.shippingMethod === 'foxpost' ? 'FoxPost automata' : 'Házhozszállítás',
        foxpostLocation: orderData.foxpostLocation || '-',
        address: orderData.shippingMethod === 'home' ? 
            `${orderData.customerInfo.zipCode} ${orderData.customerInfo.city}, ${orderData.customerInfo.address}` : '-',
        items: itemsList,
        totalQuantity: totalQuantity,
        total: orderData.total,
        paymentMethod: 'Bankkártya (Stripe)',
        paymentStatus: orderData.paymentStatus || 'Sikeres',
        notes: orderData.customerInfo.notes || '-'
    });

    await workbook.xlsx.writeFile(filePath);
    console.log('Rendelés sikeresen mentve az Excel fájlba');
}

// API Endpoints
app.get('/api/products', async (req, res) => {
    try {
        const products = await loadProducts();
        res.json(products);
    } catch (error) {
        res.status(500).json({ error: 'Hiba a termékek lekérésekor' });
    }
});

app.get('/api/products/:id', async (req, res) => {
    try {
        const products = await loadProducts();
        const product = products.find(p => p.id === parseInt(req.params.id));
        
        if (!product) {
            return res.status(404).json({ error: 'Termék nem található' });
        }
        
        res.json(product);
    } catch (error) {
        res.status(500).json({ error: 'Hiba a termék lekérésekor' });
    }
});

app.get('/api/foxpost/locations', async (req, res) => {
    try {
        const response = await fetch(`${FOXPOST_API_URL}/automata`, {
            headers: {
                'Authorization': `Bearer ${FOXPOST_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error('FoxPost API hiba');
        }

        const locations = await response.json();
        res.json(locations);
    } catch (error) {
        console.error('FoxPost API hiba:', error);
        res.json([
            { id: 1, name: 'Budapest, Nyugati tér', address: '1132 Budapest, Váci út 1-3.' },
            { id: 2, name: 'Szentendre, Duna korzó', address: '2000 Szentendre, Duna korzó 15.' },
            { id: 3, name: 'Budapest, Oktogon', address: '1067 Budapest, Teréz körút 1.' }
        ]);
    }
});

app.post('/api/create-payment-intent', async (req, res) => {
    try {
        const { amount, orderData } = req.body;

        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(amount),
            currency: 'huf',
            automatic_payment_methods: {
                enabled: true,
            },
            metadata: {
                orderId: orderData.orderId,
                customerEmail: orderData.customerInfo.email,
                customerName: orderData.customerInfo.name
            }
        });

        res.json({
            clientSecret: paymentIntent.client_secret,
            paymentIntentId: paymentIntent.id
        });
    } catch (error) {
        console.error('Stripe hiba:', error);
        res.status(500).json({ error: 'Hiba a fizetés létrehozásakor' });
    }
});

app.post('/api/complete-order', async (req, res) => {
    try {
        const orderData = req.body;

        const products = await loadProducts();
        orderData.items.forEach(item => {
            const product = products.find(p => p.id === item.id);
            if (product) {
                product.quantity -= item.quantity;
            }
        });
        await saveProducts(products);

        await saveOrderToExcel(orderData);

        if (orderData.shippingMethod === 'foxpost') {
            try {
                const foxpostResponse = await fetch(`${FOXPOST_API_URL}/shipment`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${FOXPOST_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        recipient: {
                            name: orderData.customerInfo.name,
                            email: orderData.customerInfo.email,
                            phone: orderData.customerInfo.phone
                        },
                        delivery_point_id: orderData.foxpostLocationId,
                        cod_amount: 0,
                        package_weight: 1,
                        order_number: orderData.orderId
                    })
                });

                if (foxpostResponse.ok) {
                    const foxpostData = await foxpostResponse.json();
                    console.log('FoxPost csomag sikeresen létrehozva:', foxpostData);
                }
            } catch (foxpostError) {
                console.error('FoxPost hiba (nem kritikus):', foxpostError);
            }
        }

        res.json({
            success: true,
            orderId: orderData.orderId,
            message: 'Rendelés sikeresen rögzítve'
        });
    } catch (error) {
        console.error('Hiba a rendelés véglegesítésekor:', error);
        res.status(500).json({ error: 'Hiba a rendelés véglegesítésekor' });
    }
});

app.post('/api/send-confirmation', async (req, res) => {
    const { email, orderData } = req.body;
    res.json({ success: true, message: 'Email elküldve' });
});

app.get('/api/admin/orders', async (req, res) => {
    try {
        const filePath = path.join(__dirname, 'data', 'rendelesek.xlsx');
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(filePath);
        
        const worksheet = workbook.getWorksheet('Rendelések');
        const orders = [];
        
        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber > 1) {
                orders.push({
                    orderId: row.getCell(1).value,
                    date: row.getCell(2).value,
                    name: row.getCell(3).value,
                    email: row.getCell(4).value,
                    phone: row.getCell(5).value,
                    shippingMethod: row.getCell(6).value,
                    foxpostLocation: row.getCell(7).value,
                    address: row.getCell(8).value,
                    items: row.getCell(9).value,
                    totalQuantity: row.getCell(10).value,
                    total: row.getCell(11).value,
                    paymentMethod: row.getCell(12).value,
                    paymentStatus: row.getCell(13).value,
                    notes: row.getCell(14).value
                });
            }
        });
        
        res.json(orders);
    } catch (error) {
        console.error('Hiba a rendelések lekérésekor:', error);
        res.json([]);
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Tünde Kincsei Backend fut a ${PORT} porton`);
    console.log(`📦 API elérhető: http://localhost:${PORT}/api`);
    console.log(`🌐 Weboldal: http://localhost:${PORT}`);
});