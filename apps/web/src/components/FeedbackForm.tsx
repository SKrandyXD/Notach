import { useId } from "react";
import { useI18n } from "../i18n/useI18n.js";
import { AsyncButtonLabel } from "./AsyncButtonLabel.js";
import { Icon } from "./Icon.js";

const ratingDescriptions = [
  "feedback.score1",
  "feedback.score2",
  "feedback.score3",
  "feedback.score4",
  "feedback.score5",
] as const;

interface FeedbackFormProps {
  rating: number;
  onRatingChange: (rating: number) => void;
  comment: string;
  onCommentChange: (comment: string) => void;
  accepted: boolean;
  onAcceptedChange: (accepted: boolean) => void;
  saving: boolean;
  onSubmit: () => void;
}

export function FeedbackForm({
  rating,
  onRatingChange,
  comment,
  onCommentChange,
  accepted,
  onAcceptedChange,
  saving,
  onSubmit,
}: FeedbackFormProps) {
  const { t, formatNumber } = useI18n();
  const id = useId();
  const selectedDescription = ratingDescriptions[rating - 1];

  return (
    <form
      className="feedback-form"
      aria-busy={saving}
      onSubmit={(event) => {
        event.preventDefault();
        if (!saving) onSubmit();
      }}
    >
      <div className="feedback-form-heading">
        <div>
          <h3>{t("feedback.prompt")}</h3>
          <p>{t("feedback.description")}</p>
        </div>
        <span className="feedback-score" aria-hidden="true">
          <strong>{formatNumber(rating)}</strong>
          <span>/ {formatNumber(5)}</span>
        </span>
      </div>
      <div>
        <div
          className="feedback-stars"
          role="radiogroup"
          aria-label={t("feedback.ratingLabel")}
          aria-describedby={`${id}-rating-description`}
        >
          {[1, 2, 3, 4, 5].map((value) => (
            <label
              key={value}
              className="feedback-star"
              data-filled={value <= rating}
            >
              <input
                type="radio"
                name={`${id}-rating`}
                value={value}
                checked={value === rating}
                disabled={saving}
                aria-label={t("feedback.rating", { rating: value })}
                onChange={() => onRatingChange(value)}
              />
              <span className="feedback-star-content" aria-hidden="true">
                <Icon name="star" />
                <span>{formatNumber(value)}</span>
              </span>
            </label>
          ))}
        </div>
        <p
          id={`${id}-rating-description`}
          className="feedback-rating-description"
          role="status"
        >
          {selectedDescription ? t(selectedDescription) : "\u00a0"}
        </p>
        <div className="feedback-scale" aria-hidden="true">
          <span>{t("feedback.scaleLow")}</span>
          <span>{t("feedback.scaleHigh")}</span>
        </div>
      </div>
      <label className="feedback-comment">
        <span>
          {t("feedback.comment")}
          <small>{t("feedback.optional")}</small>
        </span>
        <textarea
          aria-label={t("feedback.comment")}
          placeholder={t("feedback.commentPlaceholder")}
          value={comment}
          onChange={(event) => onCommentChange(event.target.value)}
          disabled={saving}
          maxLength={1000}
          rows={3}
        />
      </label>
      <label className="feedback-accepted">
        <input
          type="checkbox"
          checked={accepted}
          disabled={saving}
          onChange={(event) => onAcceptedChange(event.target.checked)}
        />
        <span>{t("feedback.accepted")}</span>
      </label>
      <div className="feedback-submit-row">
        <button
          type="submit"
          className="button small primary"
          disabled={saving}
          aria-busy={saving}
        >
          <AsyncButtonLabel
            idle={t("feedback.save")}
            busy={t("state.saving")}
            loading={saving}
          />
        </button>
      </div>
    </form>
  );
}
