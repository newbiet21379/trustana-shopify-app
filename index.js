const crypto = require('crypto');
const nonce = require('nonce')();
const request = require('request-promise');
const querystring = require('querystring');
const cookie = require('cookie');
const express = require('express');
const dotenv = require("dotenv");
const Shopify = require("@shopify/shopify-api");
const {DataType} = require("@shopify/shopify-api");

const app = express();
dotenv.config();
const port = parseInt(process.env.PORT, 10) || 8081;
const dev = process.env.NODE_ENV !== "production";

app.get('/shopify', (req, res) => {
    // Shop Name
    const shopName = req.query.shop;
    if (shopName) {

        const shopState = nonce();
        // shopify callback redirect
        const redirectURL = process.env.HOST + '/shopify/callback';

        // Install URL for app install
        const shopifyURL = 'https://' + shopName +
            '/admin/oauth/authorize?client_id=' + process.env.SHOPIFY_API_KEY +
            '&scope=' + process.env.SCOPES +
            '&state=' + shopState +
            '&redirect_uri=' + redirectURL;

        res.cookie('state', shopState);
        res.redirect(shopifyURL);
    } else {
        return res.status(400).send('Missing "Shop Name" parameter!!');
    }
});

app.get('/shopify/callback', (req, res) => {
    const {shop, hmac, code, state} = req.query;
    const stateCookie = cookie.parse(req.headers.cookie).state;

    if (state !== stateCookie) {
        return res.status(403).send('Request origin cannot be verified '+JSON.stringify(req.query));
    }

    if (shop && hmac && code) {
        const queryMap = Object.assign({}, req.query);
        delete queryMap['signature'];
        delete queryMap['hmac'];

        const message = querystring.stringify(queryMap);
        const providedHmac = Buffer.from(hmac, 'utf-8');
        const generatedHash = Buffer.from(crypto.createHmac('sha256', process.env.SHOPIFY_API_SECRET).update(message).digest('hex'), 'utf-8');

        let hashEquals = false;

        try {
            hashEquals = crypto.timingSafeEqual(generatedHash, providedHmac);
        } catch (e) {
            hashEquals = false;
        }

        if (!hashEquals) {
            return res.status(400).send('HMAC validation failed');
        }
        const accessTokenRequestUrl = 'https://' + shop + '/admin/oauth/access_token';
        const accessTokenPayload = {
            client_id: process.env.SHOPIFY_API_KEY,
            client_secret: process.env.SHOPIFY_API_SECRET,
            code,
        };

        request.post(accessTokenRequestUrl, {json: accessTokenPayload})
            .then((accessTokenResponse) => {
                // const accessToken = accessTokenResponse.access_token;
                res.end(JSON.stringify(accessTokenResponse))
                // const shopRequestURL = 'https://' + shop + '/admin/api/2020-04/shop.json';
                // const shopRequestHeaders = {'X-Shopify-Access-Token': accessToken};
                //
                // request.get(shopRequestURL, {headers: shopRequestHeaders})
                //     .then((shopResponse) => {
                //         res.end(shopResponse)
                //         // res.redirect('https://' + shop + '/admin/apps');
                //     })
                //     .catch((error) => {
                //         res.status(error.statusCode).send(error);
                //     });
            })
            .catch((error) => {
                res.status(error.statusCode).send(error);
            });

    } else {
        res.status(400).send('Required parameters missing');
    }
});

app.post("/createProduct", async (req,res) => {
    try {
        // const client = new Shopify.Clients.Rest(savedShop, savedAccessToken);
        const shop = req.header.shop;
        const accessToken = req.header.authorization;

        console.log("SHOP", shop);
        console.log("ACCESS TOKEN", accessToken);
        console.log("BODY", req.request.body);

        const productPayload = {
            ...req.request.body.product,
            metafields: [
                {
                    key: "ihubCheck",
                    value: "ihub",
                    value_type: "string",
                    type: "single_line_text_field",
                    namespace: "global",
                },
            ],
        };
        const client = new Shopify.Clients.Rest(shop, accessToken);
        const data = await client.post({
            path: "products",
            data: {
                product: productPayload,
            },
            type: DataType.JSON,
        });
        console.log(
            "Created Product " + JSON.stringify(req.request.body.product)
        );
        const dataProducts = await client.get({
            path: "products",
            query: { fields: "id,tags" },
        });
        const productFilter = dataProducts.body.products.filter((e) => {
            return e.tags === req.request.body.product.tags;
        });
        console.log("Query Product ", JSON.stringify(productFilter));

        res.send("OK");
    } catch (err) {
        console.log(err);
        res.status(err.statusCode).send(err);
    }
});

app.post("/updateProduct", async (req,res) => {
    try {
        // const client = new Shopify.Clients.Rest(savedShop, savedAccessToken);
        const shop = req.header.shop;
        const accessToken = req.header.authorization;
        const client = new Shopify.Clients.Rest(shop, accessToken);
        const product = req.request.body.product;
        const ihubCode = product.tags;

        const result = await findProduct(ihubCode, client);
        console.log("Product :", JSON.stringify(result));
        if (result != null && result) {
            const productBody = {
                product: {
                    ...product,
                    id: result.id,
                },
            };
            const data = await client.put({
                path: "products/" + result.id,
                data: productBody,
                type: DataType.JSON,
            });
            console.log("Updated Product " + data);

            res.send("OK");
        } else {
            res.status(404).send("Product Not Found")
        }
    } catch (err) {
        console.log(err);
        res.status(err.statusCode).send(err);
    }
});

app.post("/deleteProduct", async (req,res) => {
    try {
        // const client = new Shopify.Clients.Rest(savedShop, savedAccessToken);
        const shop = req.header.shop;
        const accessToken = req.header.authorization;
        const client = new Shopify.Clients.Rest(shop, accessToken);
        const ihubCode = req.request.body.ihubCode;

        const product = await findProduct(ihubCode, client);
        if (product != null && product) {
            const data = await client.delete({
                path: "products/" + product.id,
            });
            console.log("Deleted Product ", data, product);
            res.send("OK");
        } else {
            res.status(404).send("Product Not Found");
        }
    } catch (err) {
        console.log(err);
        res.status(err.statusCode).send(err)
    }
});

app.get("/checkIhubRequest", async (req,res) => {
    try {
        const shop = req.header.shop;
        const accessToken = req.header.authorization;
        const client = new Shopify.Clients.Rest(shop, accessToken);
        const productId = req.request.body.productId;

        const dataMetafields = await client.get({
            path: `products/${productId}/metafields`,
            type: DataType.JSON,
        });
        const metafields = dataMetafields.body.metafields;
        if (!metafields.length) {
            res.status(200).send({check:true})
            return;
        }
        const checkMetafields = metafields.filter(
            (meta) => meta.key == "ihubCheck"
        );
        if (!checkMetafields.length) {
            res.status(200).send({check:true})
            return;
        }

        res.status(200).send({check:false})
    } catch (err) {
        res.status(err.statusCode).send({error:err,check:false})
    }
});

app.get("/getProducts", async (req,res) => {
    try {
        const shop = ctx.header.shop;
        const accessToken = ctx.header.authorization;
        const client = new Shopify.Clients.Rest(shop, accessToken);
        const dataProducts = await client.get({
            path: "products",
            query: { fields: "id,tags" },
        });
        res.status(200).send(dataProducts)
    } catch (err) {
        console.log(err);
        res.status(err.statusCode).send(err)
    }
});

const findProduct = async (ihubCode, client) => {
    let dataProducts = await client.get({
        path: "products",
        query: { fields: "id,tags", limit: `250` },
    });

    const foundProduct = dataProducts.body.products.find(
        (item) => item.tags == ihubCode
    );
    if (foundProduct) return foundProduct;
    let products = dataProducts.body.products;

    let product = products.find((item) => item.tags == ihubCode);
    while (product === undefined && products.length > 0) {
        const data = await client.get({
            path: "products",
            query: {
                fields: "id,tags",
                limit: `250`,
                since_id: products[products.length - 1].id,
            },
        });
        products = data.body.products;
        product = products.find((item) => item.tags == ihubCode);
    }

    if (product) {
        return product;
    }
    return null;
};
app.listen(8081, () => console.log('Application listening on port 8081!'));