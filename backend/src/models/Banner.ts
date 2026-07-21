import { Schema, models, model } from "mongoose";

const BannerSchema = new Schema(
  {
    title: { type: String, required: true },
    subtitle: { type: String, default: "" },
    tag: { type: String, default: "" },
    imageUrl: { type: String, required: true },
    ctaLabel: { type: String, default: "" },
    ctaHref: { type: String, default: "" },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

BannerSchema.index({ order: 1 });

export default models.Banner || model("Banner", BannerSchema);
