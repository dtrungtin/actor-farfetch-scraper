const Apify = require('apify');
const url = require('url');
const querystring = require('querystring');
const _ = require('underscore');
const safeEval = require('safe-eval');

const { log } = Apify.utils;
log.setLevel(log.LEVELS.WARNING);

function delay(time) {
    return new Promise(((resolve) => {
        setTimeout(resolve, time);
    }));
}

const isObject = val => typeof val === 'object' && val !== null && !Array.isArray(val);

let detailsEnqueued = 0;

Apify.events.on('migrating', async () => {
    await Apify.setValue('detailsEnqueued', detailsEnqueued);
});

Apify.main(async () => {
    const input = await Apify.getInput();
    console.log('Input:');
    console.dir(input);

    if (!input || !Array.isArray(input.startUrls) || input.startUrls.length === 0) {
        throw new Error("Invalid input, it needs to contain at least one url in 'startUrls'.");
    }

    let extendOutputFunction;
    if (typeof input.extendOutputFunction === 'string' && input.extendOutputFunction.trim() !== '') {
        try {
            extendOutputFunction = safeEval(input.extendOutputFunction);
        } catch (e) {
            throw new Error(`'extendOutputFunction' is not valid Javascript! Error: ${e}`);
        }
        if (typeof extendOutputFunction !== 'function') {
            throw new Error('extendOutputFunction is not a function! Please fix it or use just default ouput!');
        }
    }

    const requestQueue = await Apify.openRequestQueue();

    detailsEnqueued = await Apify.getValue('detailsEnqueued');
    if (!detailsEnqueued) {
        detailsEnqueued = 0;
    }

    function checkLimit() {
        return input.maxItems && detailsEnqueued >= input.maxItems;
    }

    for (const item of input.startUrls) {
        const startUrl = item.url;

        if (checkLimit()) {
            break;
        }

        if (startUrl.includes('https://www.farfetch.com/')) {
            if (startUrl.match(/\d+.aspx/)) {
                await requestQueue.addRequest({ url: startUrl, userData: { label: 'item' } }, { forefront: true });
                detailsEnqueued++;
            } else {
                await requestQueue.addRequest({ url: startUrl, userData: { label: 'start' } });
            }
        }
    }

    const crawler = new Apify.CheerioCrawler({
        requestQueue,

        minConcurrency: 2,
        maxConcurrency: 5,
        maxRequestRetries: 1,
        handlePageTimeoutSecs: 60,

        handlePageFunction: async ({ request, body, $ }) => {
            await delay(1000);
            console.log(`Processing ${request.url}...`);

            if (request.userData.label === 'start') {
                const itemLinks = $('a[itemprop=itemListElement]');
                if (itemLinks.length === 0) {
                    return;
                }

                let firstItemId = '';
                for (let index = 0; index < itemLinks.length; index++) {
                    if (checkLimit()) {
                        break;
                    }

                    if (index === 0) {
                        firstItemId = $(itemLinks[index]).attr('itemid');
                    }
                    
                    const itemUrl = 'https://www.farfetch.com' + $(itemLinks[index]).attr('href');
                    await requestQueue.addRequest({ url: `${itemUrl}`, userData: { label: 'item' } }, { forefront: true });
                    detailsEnqueued++;
                }

                let parsedUrl = url.parse(request.url);
                let params = querystring.parse(parsedUrl.query);
                params.page = 2;

                parsedUrl.query = querystring.stringify(params);
                const nextPageUrl = 'https://www.farfetch.com' + parsedUrl.pathname + '?' + parsedUrl.query;

                await requestQueue.addRequest({ url: `${nextPageUrl}`, userData: { label: 'list', stopItemId: firstItemId } });
            } else if (request.userData.label === 'list') {
                let stopId = request.userData.stopItemId;
                const itemLinks = $('a[itemprop=itemListElement]');
                if (itemLinks.length === 0) {
                    return;
                }

                for (let index = 0; index < itemLinks.length; index++) {
                    if (checkLimit()) {
                        break;
                    }

                    const itemId = $(itemLinks[index]).attr('itemid');
                    if (itemId === stopId) { // TODO: Maybe loop forever
                        return;
                    }

                    const itemUrl = 'https://www.farfetch.com' + $(itemLinks[index]).attr('href');
                    await requestQueue.addRequest({ url: `${itemUrl}`, userData: { label: 'item' } }, { forefront: true });
                    detailsEnqueued++;
                }

                let parsedUrl = url.parse(request.url);
                let params = querystring.parse(parsedUrl.query);
                if (!params.page) {
                    return;
                }

                if (checkLimit()) {
                    return;
                }

                params.page++;

                parsedUrl.query = querystring.stringify(params);
                const nextPageUrl = 'https://www.farfetch.com' + parsedUrl.pathname + '?' + parsedUrl.query;

                await requestQueue.addRequest({ url: `${nextPageUrl}`, userData: { label: 'list', stopItemId: stopId } });
            } else if (request.userData.label === 'item') {
                const name = $('span[itemprop=name]').text();
                const itemId = $('[itemprop=productID]').attr('content');
                const price = $('[aria-label="[Product information]"] [data-tstid="priceInfo-original"]').text();
                const color = $('[itemprop=color]').attr('content');
                const sizes = [];
                $('[aria-label="[Product information]"] select').find('option').each((i,op) => {
                    if (i > 0) {
                        sizes.push($(op).text().trim());
                    }
                });

                const pageResult = {
                    url: request.url,
                    name,
                    itemId,
                    color,
                    sizes,
                    price,
                    '#debug': Apify.utils.createRequestDebugInfo(request),
                };

                if (extendOutputFunction) {
                    const userResult = await extendOutputFunction($);

                    if (!isObject(userResult)) {
                        console.log('extendOutputFunction has to return an object!!!');
                        process.exit(1);
                    }

                    _.extend(pageResult, userResult);
                }

                await Apify.pushData(pageResult);
            }
        },

        // This function is called if the page processing failed more than maxRequestRetries+1 times.
        handleFailedRequestFunction: async ({ request }) => {
            console.log(`Request ${request.url} failed twice.`);
        },

        ...input.proxyConfiguration,
    });

    // Run the crawler and wait for it to finish.
    await crawler.run();

    console.log('Crawler finished.');
});
