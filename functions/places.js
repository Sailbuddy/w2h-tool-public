const fetch = require("node-fetch");

exports.handler = async function (event, context) {
  const input = event.queryStringParameters?.input || "GH7V+C9 Portorož, Slovenia";
  const apiKey = process.env.GOOGLE_API_KEY;

  const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(input)}&inputtype=textquery&key=${apiKey}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    return {
      statusCode: 200,
      body: JSON.stringify({ result: data }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "API request failed" }),
    };
  }
};