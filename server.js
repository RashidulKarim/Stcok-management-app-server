const express = require('express');
const app = express();
const { MongoClient } = require('mongodb');
const cors = require("cors")
const ObjectId = require('mongodb').ObjectId
const cron = require('node-cron');
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
require('dotenv').config()

const port = process.env.PORT || 5000;
const whitelist = ["https://rafimeds.web.app"]
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || whitelist.indexOf(origin) !== -1) {
      callback(null, true)
    } else {
      callback(new Error("Not allowed by CORS"))
    }
  },
  credentials: true,
}
//remove cors for development
// app.use(cors(corsOptions))
app.use(cors({
  origin: 'http://localhost:5173',
}));
app.use(express.json())


const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.wbvsa.mongodb.net/${process.env.DB_NAME}?retryWrites=true&w=majority`;

const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });

const run = async () => {
  try {
    await client.connect()
    const database = client.db(process.env.DB_NAME)
    const collection = database.collection("products")
    const stockCollection = database.collection("stockProducts")
    const historyCollection = database.collection("history")
    const stockHistoryCollection = database.collection("stockHistory")
    const productsDb = database.collection("productsDb");

    app.get('/allUsers', async (req, res) => {
      admin.auth().listUsers()
        .then((listUsersResult) => {
          const users = listUsersResult.users.map(user => user.email)
          res.send(users)
        })
        .catch((error) => {
          res.send(error)
        });
    })

    app.get('/setDummyData', async (req, res) => {
      await collection.deleteMany({ name: { $regex: /product/i }, company: 'whitehorse' });
      const products = await productsDb.find({ name: { $regex: /product/i } }).toArray();
      products.forEach(product => {
        product.quantity = 1;
      })
      const result = await collection.insertMany(products);
      res.send(result);
    })

    //get all product from DB ** working
    app.get("/getProducts", async (req, res) => {
      const type = req.query?.type

      if (type === 'product') {
        // await productsDb.updateMany({}, [{ $set: { label: "$name" } }]);
        const shortProduct = await collection.find({}).sort({ "company": 1 }).toArray()
        res.send(shortProduct)
      } else if (type === 'stock') {
        const result = await stockCollection.find({}).sort({ "company": 1 }).toArray()
        res.send(result)
      }
    })

    //get all dbProducts from DB ** working check if email props if not then return message or return all dbProducts
    app.get("/getDbProducts", async (req, res) => {
        const result = await productsDb.find({}).sort({ "company": 1 }).toArray();
        res.send(result)
     
    })

    //add products to DB ** working
    app.post('/addProducts', async (req, res) => {
      const products = req.body.productsCollection
      const type = req.query?.type

      let modifiedCount = 0;
      let insertedCount = 0;

      for (const pd of products) {
        const filter = { _id: ObjectId(pd._id) };
        const options = { upsert: true };
        if (pd.hasOwnProperty('_id')) {
          delete pd._id;
        }
    
        const update = { $set: pd }

        let result;
        if (type === 'product') {
          const dbProductProperties = {}
          pd.mrp && (dbProductProperties.mrp = pd.mrp);
          pd.lpp && (dbProductProperties.lpp = pd.lpp);
          pd.name && (dbProductProperties.name = pd.name.toLowerCase().trim());
          pd.label && (dbProductProperties.label = pd.label.toLowerCase().trim());
          pd.company && (dbProductProperties.company = pd.company);
          typeof pd.market === 'boolean' && (dbProductProperties.market = pd.market)
          // pd.market ? dbProductProperties.market = pd.market : null;
          if(Object.keys(dbProductProperties).length > 1) {
            const data = await productsDb.updateOne({ name: pd.name.toLowerCase().trim() }, { $set: dbProductProperties }, { upsert: true });
          }
          if(pd.hasOwnProperty('dbId')) {
          // set the dbId to _id for the productsDb
          pd._id = ObjectId(pd.dbId);
          delete pd.dbId;

          // Check if a document with the same _id already exists
          const existingDoc = await collection.findOne({ _id: pd._id });

          if (existingDoc) {
            // If the document exists, update it
            result = await collection.updateOne({ _id: pd._id }, { $set: pd });
          } else {
            // If the document does not exist, insert a new one
            result = await collection.insertOne(pd);
            }
          } else {
            result = await collection.updateOne(filter, update, options);
          }
        } else if (type === 'stock') {
          result = await stockCollection.updateOne(filter, update, options);
        }
        if(result?.insertedId) {
          insertedCount++;
        } else if ((result.upsertedCount) > 0) {
          insertedCount++;
        } else if (result.modifiedCount > 0) {
          modifiedCount++;
        }
      }
      res.send({ modifiedCount, insertedCount });
    })



    //delete many product ** working
    app.delete('/deleteProducts', async (req, res) => {
      const query = req.body
      const type = req.query?.type
      const data = query.map(pd => {
        return ObjectId(pd._id)
      })
      let result;
      if (type === 'product') {
        result = await collection.deleteMany({ _id: { $in: data } })
      } else if (type === 'stock') {
        result = await stockCollection.deleteMany({ _id: { $in: data } })
      }
      res.send(result)
    })

    //add a history to DB ** working
    app.post('/addHistory', async (req, res) => {
      const history = req.body
      await historyCollection.insertMany(history)
    })

    //add a history to DB ** working
    app.post('/addStockHistory', async (req, res) => {
      const history = req.body
      await stockHistoryCollection.insertMany(history)
    })

    //make a api to get just length of the stockProducts and products together length send it with a object
    //link {products: 100, stockProducts: 100}
    app.get('/getProductsLength', async (req, res) => {
      const shortProduct = await collection.find({}).count()
      const stockProductsLength = await stockCollection.find({}).count()
      res.send({ shortProduct, stockProductsLength })
    })

    // modify a product. get all data from body array and loop through the product and get all product has quantity with id and check if query type === 'product' then check the quantity if it is 0 then delete the product

    app.post('/modifyProducts', async (req, res) => {
      const products = req.body
      const type = req.query?.type
      let modifiedCount = 0;
      let deletedCount = 0;
      if (type === 'product') {
        for (const pd of products) {
          // if(pd.hasOwnProperty('lpp')) {
          //   await productsDb.updateOne({ _id: ObjectId(pd._id) }, { $set: { lpp: pd.lpp } });
          // }
          if (pd.hasOwnProperty('lpp')) {
            const objectIdMatch = await productsDb.findOne({ _id: ObjectId(pd._id) });
            console.log("objectIdMatch",objectIdMatch)
            if (objectIdMatch) {
              await productsDb.updateOne({ _id: ObjectId(pd._id) }, { $set: { lpp: pd.lpp } });
            } else {
              const product = await collection.findOne({ _id: ObjectId(pd._id) });
              console.log("product", product.name?.toLowerCase()?.trim())
              if(product) {
                await productsDb.updateOne({ name: product.name?.toLowerCase()?.trim() }, { $set: { lpp: pd.lpp } });
              }
            }
          }
          if (pd.quantity === 0) {
            const result = await collection.deleteOne({ _id: ObjectId(pd._id) })
            if (result.deletedCount === 1) {
              deletedCount++;
            }
          } else {
            const filter = { _id: ObjectId(pd._id) };
            const options = { upsert: false };
            delete pd._id;
            const update = { $set: pd }
            const result = await collection.updateOne(filter, update, options);
            if (result.modifiedCount > 0) {
              modifiedCount++;
            }
          }
        }
      } else if (type === 'stock') {
        for (const pd of products) {
          const filter = { _id: ObjectId(pd._id) };
          const options = { upsert: false };
          delete pd._id;
          const update = { $set: pd }
          const result = await stockCollection.updateOne(filter, update, options);
          if (result.modifiedCount > 0) {
            modifiedCount++;
          }
        }
      }
      res.send({ modifiedCount, deletedCount })
    })


    app.get('/getHistory', async (req, res) => {
      try {
        const { email, count, type, page } = req.query;
    
        if (!count || !type || !page) {
          return res.status(400).send('"count", "type", and "page" query parameters are required.');
        }
    
        const parsedCount = parseInt(count, 10);
        const parsedPage = parseInt(page, 10);
    
        if (isNaN(parsedCount) || parsedCount <= 0 || isNaN(parsedPage) || parsedPage <= 0) {
          return res.status(400).send('Invalid "count" or "page" value.');
        }
    
        const itemsPerPage = parsedCount;
        const skipItems = (parsedPage - 1) * itemsPerPage;
    
        let collectionToSearch;
        if (type === 'stock') {
          collectionToSearch = stockHistoryCollection;
        } else if (type === 'short') {
          collectionToSearch = historyCollection;
        } else {
          return res.status(400).send('Invalid "type" value. Use "stockProduct" or "stock".');
        }
        let query = {};
        if (email !== 'all') {
          query.user = email;
        }
    
        const historyCount = await collectionToSearch.countDocuments(query);
        const historyData = await collectionToSearch.find(query)
          .sort({ date: -1 })
          .skip(skipItems)
          .limit(itemsPerPage)
          .toArray();
    
        res.send({ historyCount, historyData });
      } catch (error) {
        console.error('Error fetching history data:', error);
        res.status(500).send('Internal Server Error');
      }
    });

    async function deleteOldRecords() {
      try {
        const tenDaysAgo = new Date();
        tenDaysAgo.setDate(tenDaysAgo.getDate() - 5);
    
        // Delete from history collection
        const resultHistory = await client.db(process.env.DB_NAME).collection("history").deleteMany({ date: { $lt: tenDaysAgo.toISOString() } });
        console.log(`Deleted ${resultHistory.deletedCount} old records from history collection.`);
    
        // Delete from stockHistory collection
        const resultStockHistory = await client.db(process.env.DB_NAME).collection("stockHistory").deleteMany({ date: { $lt: tenDaysAgo.toISOString() } });
        console.log(`Deleted ${resultStockHistory.deletedCount} old records from stockHistory collection.`);
      } catch (error) {
        console.error('Error while deleting old records:', error);
      }
    }
    
    cron.schedule('0 0 * * *', deleteOldRecords);    

  } catch (error) {
    console.log(error);
    process.exit(1)
  }
}

run().then(() => {
  console.log("Database connected");
  app.listen(port, () => {
    console.log("Listening from port", port)

  })
})

app.get('/', (req, res) => {
  res.send("Welcome to Rafi Medicine center shortlist server")
})

cron.schedule('*/14 * * * *', async () => {
  console.log('running a task every 10 minutes');
});



