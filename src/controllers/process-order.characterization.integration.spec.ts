import {
	describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import {type FastifyInstance} from 'fastify';
import supertest from 'supertest';
import {eq} from 'drizzle-orm';
import {type DeepMockProxy, mockDeep} from 'vitest-mock-extended';
import {asValue} from 'awilix';
import {type INotificationService} from '@/services/notifications.port.js';
import {
	type ProductInsert,
	products,
	orders,
	ordersToProducts,
} from '@/db/schema.js';
import {type Database} from '@/db/type.js';
import {buildFastify} from '@/fastify.js';

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days: number) => new Date(Date.now() + (days * DAY));

type Expectation = {
	available: number;
	notify?: 'delay' | 'outOfStock' | 'expiration';
};

describe('processOrder — comportement existant', () => {
	let fastify: FastifyInstance;
	let database: Database;
	let notificationServiceMock: DeepMockProxy<INotificationService>;

	beforeEach(async () => {
		notificationServiceMock = mockDeep<INotificationService>();
		fastify = await buildFastify();
		fastify.diContainer.register({
			ns: asValue(notificationServiceMock as INotificationService),
		});
		await fastify.ready();
		database = fastify.database;
	});

	afterEach(async () => {
		await fastify.close();
	});

	async function processOrderWith(product: ProductInsert) {
		const orderId = database.transaction(tx => {
			const inserted = tx.insert(products).values(product).returning({productId: products.id}).get();
			const order = tx.insert(orders).values({}).returning({orderId: orders.id}).get();
			tx.insert(ordersToProducts).values({orderId: order.orderId, productId: inserted.productId}).run();
			return order.orderId;
		});

		await supertest(fastify.server).post(`/orders/${orderId}/processOrder`).expect(200);

		return database.query.products.findFirst({where: eq(products.name, product.name)});
	}

	function expectNotification(product: ProductInsert, expectation: Expectation) {
		const delay = notificationServiceMock.sendDelayNotification;
		const outOfStock = notificationServiceMock.sendOutOfStockNotification;
		const expiration = notificationServiceMock.sendExpirationNotification;

		expect(delay).toHaveBeenCalledTimes(expectation.notify === 'delay' ? 1 : 0);
		expect(outOfStock).toHaveBeenCalledTimes(expectation.notify === 'outOfStock' ? 1 : 0);
		expect(expiration).toHaveBeenCalledTimes(expectation.notify === 'expiration' ? 1 : 0);

		if (expectation.notify === 'delay') {
			expect(delay).toHaveBeenCalledWith(product.leadTime, product.name);
		}

		if (expectation.notify === 'outOfStock') {
			expect(outOfStock).toHaveBeenCalledWith(product.name);
		}

		if (expectation.notify === 'expiration') {
			expect(expiration).toHaveBeenCalledWith(product.name, product.expiryDate);
		}
	}

	describe('produit NORMAL', () => {
		it.each<[string, ProductInsert, Expectation]>([
			[
				'en stock : décrémente sans notifier',
				{
					type: 'NORMAL', name: 'normal-in-stock', leadTime: 15, available: 30,
				},
				{available: 29},
			],
			[
				'en rupture avec un délai : notifie le délai',
				{
					type: 'NORMAL', name: 'normal-out-of-stock', leadTime: 10, available: 0,
				},
				{available: 0, notify: 'delay'},
			],
			[
				'en rupture sans délai : ne notifie rien',
				{
					type: 'NORMAL', name: 'normal-no-lead-time', leadTime: 0, available: 0,
				},
				{available: 0},
			],
		])('%s', async (_label, product, expectation) => {
			const result = await processOrderWith(product);

			expect(result!.available).toBe(expectation.available);
			expectNotification(product, expectation);
		});
	});

	describe('produit SEASONAL', () => {
		it.each<[string, ProductInsert, Expectation]>([
			[
				'en saison et en stock : décrémente sans notifier',
				{
					type: 'SEASONAL', name: 'seasonal-in-season', leadTime: 15, available: 30, seasonStartDate: inDays(-2), seasonEndDate: inDays(58),
				},
				{available: 29},
			],
			[
				'en saison, rupture, réapprovisionnement avant la fin de saison : notifie le délai',
				{
					type: 'SEASONAL', name: 'seasonal-restock-in-time', leadTime: 15, available: 0, seasonStartDate: inDays(-2), seasonEndDate: inDays(58),
				},
				{available: 0, notify: 'delay'},
			],
			[
				'en saison, rupture, réapprovisionnement après la fin de saison : indisponible',
				{
					type: 'SEASONAL', name: 'seasonal-restock-too-late', leadTime: 15, available: 0, seasonStartDate: inDays(-50), seasonEndDate: inDays(5),
				},
				{available: 0, notify: 'outOfStock'},
			],
			[
				'saison pas commencée : notifie la rupture et garde le stock',
				{
					type: 'SEASONAL', name: 'seasonal-not-started', leadTime: 15, available: 30, seasonStartDate: inDays(180), seasonEndDate: inDays(240),
				},
				{available: 30, notify: 'outOfStock'},
			],
			[
				'saison terminée : notifie la rupture et remet le stock à 0',
				{
					type: 'SEASONAL', name: 'seasonal-ended', leadTime: 15, available: 30, seasonStartDate: inDays(-100), seasonEndDate: inDays(-10),
				},
				{available: 0, notify: 'outOfStock'},
			],
		])('%s', async (_label, product, expectation) => {
			const result = await processOrderWith(product);

			expect(result!.available).toBe(expectation.available);
			expectNotification(product, expectation);
		});
	});

	describe('produit EXPIRABLE', () => {
		it.each<[string, ProductInsert, Expectation]>([
			[
				'non expiré et en stock : décrémente sans notifier',
				{
					type: 'EXPIRABLE', name: 'expirable-valid', leadTime: 15, available: 30, expiryDate: inDays(26),
				},
				{available: 29},
			],
			[
				'expiré : notifie l\'expiration et remet le stock à 0',
				{
					type: 'EXPIRABLE', name: 'expirable-expired', leadTime: 90, available: 6, expiryDate: inDays(-2),
				},
				{available: 0, notify: 'expiration'},
			],
			[
				'non expiré mais en rupture : notifie l\'expiration (comportement historique)',
				{
					type: 'EXPIRABLE', name: 'expirable-out-of-stock', leadTime: 15, available: 0, expiryDate: inDays(26),
				},
				{available: 0, notify: 'expiration'},
			],
		])('%s', async (_label, product, expectation) => {
			const result = await processOrderWith(product);

			expect(result!.available).toBe(expectation.available);
			expectNotification(product, expectation);
		});
	});

	describe('produit de type inconnu', () => {
		it('est ignoré silencieusement (comportement actuel, à remplacer par une erreur métier)', async () => {
			const product: ProductInsert = {
				type: 'UNKNOWN', name: 'unknown-type', leadTime: 5, available: 10,
			};

			const result = await processOrderWith(product);

			expect(result!.available).toBe(10);
			expectNotification(product, {available: 10});
		});
	});
});
