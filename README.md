# QuickCompare

Personal-use price comparison app for BlinkIt, Zepto, Swiggy Instamart and Flipkart Minutes via QuickCommerce API.

## Deploy on Vercel

1. Upload this folder to a GitHub repository.
2. Import the repository into Vercel.
3. In Vercel: Settings → Environment Variables.
4. Add `QUICKCOMMERCE_API_KEY` with your API key. Do not commit the key to GitHub.
5. Redeploy.

The site asks the visitor for browser location because the QuickCommerce API requires latitude/longitude. A pincode is also sent for location-sensitive platforms such as Minutes.
