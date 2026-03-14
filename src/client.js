#!/usr/bin/env node
import * as dotenv from "dotenv";

dotenv.config({ override: true });

export default {
  messages: {
    create: async function test() {
      console.log("Testing API connection...");
      const response = await fetch(
        `${process.env.ANTHROPIC_BASE_URL}/messages`,
        {
          method: "POST",
          headers: {
            "x-api-key": process.env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify(arguments[0]),
        },
      );
      const data = await response.json();
      // console.dir(arguments);
      // console.dir(data);
      return data;
      console.log("Success! Response:", data.content[0].text);
    },
  },
};

// const response = await client.messages.create({
//   model: MODEL,
//   system: SYSTEM,
//   messages,
//   tools: TOOLS,
//   max_tokens: 8000,
// });
// test().catch(console.error);
